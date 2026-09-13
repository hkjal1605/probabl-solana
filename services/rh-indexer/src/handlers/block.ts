import { persistIndexedBlock } from "@conditional-stocks/db/indexer/writes";
import { indexerEnvironment } from "../../ponder.config.ts";
import { ponder } from "../observability.ts";

ponder.on("ProtocolBlock:block", async ({ event, context }) => {
  await persistIndexedBlock(
    context.db,
    {
      number: event.block.number,
      chainId: BigInt(context.chain.id),
      hash: event.block.hash,
      parentHash: event.block.parentHash,
      timestamp: event.block.timestamp,
    },
    indexerEnvironment,
  );
});
