import { expect, test } from "bun:test";
import { testDatabase } from "@conditional-stocks/db/testing";
import { createDatabase } from "@conditional-stocks/db/connection";
import { createPolymarketQueries } from "@conditional-stocks/db/polymarket";
import { PolymarketIngestor } from "../src/service.ts";
import { conditionId, environment, FakeSource } from "./helpers.ts";

test("unchanged reference-data service persists and recovers under a Solana deployment namespace",async()=>{
  const deployment={chainId:1,exchange:"CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3",
    solanaNamespace:"solana:genesis-a:program-a:config-a"};
  const fixture=await testDatabase({deployment}),store=createPolymarketQueries(fixture.database);
  const source=new FakeSource(),service=new PolymarketIngestor(environment,store,source);
  const metadata=await service.fetchMetadata("42");
  await service.track(metadata.snapshotId);
  expect((await service.probability(conditionId)).midpointX6).toBe("500000");
  await service.ingestSourceEvent({event_type:"price_change",market:conditionId,
    price_changes:[{asset_id:"111",price:"0.50",side:"BUY",size:"500"}],timestamp:Date.now().toString()});
  expect((await store.latestTick(conditionId))?.bestBidX6).toBe("500000");
  await service.stop();
  const second=fixture.connect();await second.verify();
  const restarted=new PolymarketIngestor(environment,createPolymarketQueries(second),source);
  expect(await restarted.probability(conditionId)).toMatchObject({quality:"disconnected",isStale:true,bestBidX6:"500000"});
  expect((await restarted.metadata(metadata.snapshotId))?.normalized.conditionId).toBe(conditionId);
  await restarted.start();expect((await restarted.probability(conditionId)).quality).toBe("valid");await restarted.stop();
  const wrong=createDatabase({...deployment,solanaNamespace:"solana:genesis-b:program-a:config-a",connectionString:fixture.connectionString});
  try {await expect(wrong.verify()).rejects.toThrow("deployment mismatch");}finally{await wrong.close();}
});
