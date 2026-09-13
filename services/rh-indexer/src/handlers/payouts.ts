import { adjustPayoutCredit, persistProtocolEvent } from "@conditional-stocks/db/indexer/writes";
import { ponder } from "../observability.ts";

ponder.on("PayoutVault:PayoutDeferred", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "PayoutVault",
      "PayoutDeferred",
      event,
    ))
  )
    return;
  if (event.args.amount <= 0n) throw new Error("Zero payout deferral");
  await adjustPayoutCredit(context.db, {
    ...event.args,
    delta: event.args.amount,
    blockNumber: event.block.number,
  });
});

ponder.on("PayoutVault:PayoutClaimed", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "PayoutVault",
      "PayoutClaimed",
      event,
    ))
  )
    return;
  if (event.args.amount <= 0n) throw new Error("Zero payout withdrawal");
  await adjustPayoutCredit(context.db, {
    ...event.args,
    delta: -event.args.amount,
    blockNumber: event.block.number,
  });
});
