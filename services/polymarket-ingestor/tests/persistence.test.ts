import { expect, test } from "bun:test";
import { createPolymarketQueries } from "@conditional-stocks/db/polymarket";
import { testDatabase } from "@conditional-stocks/db/polymarket/testing";
import { PolymarketIngestor } from "../src/service.ts";
import { conditionId, environment, FakeSource } from "./helpers.ts";

test("Polymarket source data survives an ingestor restart independently of an exchange", async () => {
  const fixture = await testDatabase();
  const store = createPolymarketQueries(fixture.database);
  const source = new FakeSource();
  const service = new PolymarketIngestor(environment, store, source);
  const metadata = await service.fetchMetadata("42");
  await service.track(metadata.snapshotId);
  expect((await service.probability(conditionId)).midpointX6).toBe("500000");
  await service.ingestSourceEvent({
    event_type: "price_change",
    market: conditionId,
    price_changes: [{ asset_id: "111", price: "0.50", side: "BUY", size: "500" }],
    timestamp: Date.now().toString(),
  });
  expect((await store.latestTick(conditionId))?.bestBidX6).toBe("500000");
  await service.stop();
  await store.close();

  const restartedStore = createPolymarketQueries(fixture.connect());
  try {
    const restarted = new PolymarketIngestor(environment, restartedStore, source);
    expect(await restarted.probability(conditionId)).toMatchObject({
      quality: "disconnected",
      isStale: true,
      bestBidX6: "500000",
    });
    expect((await restarted.metadata(metadata.snapshotId))?.normalized.conditionId).toBe(conditionId);
    await restarted.start();
    expect((await restarted.probability(conditionId)).quality).toBe("valid");
    await restarted.stop();
  } finally {
    await restartedStore.close();
  }
});
