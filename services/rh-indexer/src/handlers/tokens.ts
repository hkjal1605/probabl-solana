import { persistProtocolEvent, updateClaimBalance } from "@conditional-stocks/db/indexer/writes";
import { ponder } from "../observability.ts";

ponder.on("ConditionalTokens:TransferSingle", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "ConditionalTokens",
      "TransferSingle",
      event,
    ))
  ) {
    return;
  }
  await updateClaimBalance(
    context.db,
    event.args.from,
    event.args.id,
    -event.args.value,
    event.block.number,
  );
  await updateClaimBalance(
    context.db,
    event.args.to,
    event.args.id,
    event.args.value,
    event.block.number,
  );
});

ponder.on("ConditionalTokens:TransferBatch", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "ConditionalTokens",
      "TransferBatch",
      event,
    ))
  ) {
    return;
  }
  if (event.args.ids.length !== event.args.values.length) {
    throw new Error(`malformed TransferBatch in ${event.transaction.hash}`);
  }
  for (let index = 0; index < event.args.ids.length; index += 1) {
    const id = event.args.ids[index];
    const value = event.args.values[index];
    if (id === undefined || value === undefined) throw new Error("unreachable batch index");
    await updateClaimBalance(context.db, event.args.from, id, -value, event.block.number);
    await updateClaimBalance(context.db, event.args.to, id, value, event.block.number);
  }
});

ponder.on("ConditionalTokens:ApprovalForAll", async ({ event, context }) => {
  await persistProtocolEvent(
    context.db,
    context.chain.id,
    "ConditionalTokens",
    "ApprovalForAll",
    event,
  );
});

ponder.on("ConditionalTokens:URI", async ({ event, context }) => {
  await persistProtocolEvent(context.db, context.chain.id, "ConditionalTokens", "URI", event);
});
