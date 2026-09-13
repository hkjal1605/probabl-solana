import {
  addOrderTradingFee,
  insertResolution,
  persistProtocolEvent,
} from "@conditional-stocks/db/indexer/writes";
import { ponder } from "../observability.ts";

ponder.on("ConditionalSettlement:TradingFeeCharged", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "ConditionalSettlement",
      "TradingFeeCharged",
      event,
    ))
  )
    return;
  await addOrderTradingFee(context.db, event.args.orderHash, event.args.feeAmount);
});

ponder.on("ConditionalSettlement:CollateralSplit", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "ConditionalSettlement",
      "CollateralSplit",
      event,
    ))
  ) {
    return;
  }
});

ponder.on("PositionRouter:PositionsMerged", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "PositionRouter",
      "PositionsMerged",
      event,
    ))
  ) {
    return;
  }
});

ponder.on("PositionRouter:PositionsRedeemed", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "PositionRouter",
      "PositionsRedeemed",
      event,
    ))
  ) {
    return;
  }
});

ponder.on("ManualResolutionController:ResolutionFinalized", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "ManualResolutionController",
      "ResolutionFinalized",
      event,
    ))
  ) {
    return;
  }
  await insertResolution(context.db, {
    marketId: event.args.marketId,
    admin: event.args.admin,
    blockNumber: event.block.number,
    conditionId: event.args.conditionId,
    evidenceHash: event.args.evidenceHash,
    evidenceUri: event.args.evidenceUri,
    finalizedAt: event.args.finalizedAt,
    noPayout: event.args.noPayout,
    payoutDenominator: event.args.payoutDenominator,
    transactionHash: event.transaction.hash,
    yesPayout: event.args.yesPayout,
  });
});

ponder.on("OrderRecoveryRouter:OrderReleaseAttempt", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "OrderRecoveryRouter",
      "OrderReleaseAttempt",
      event,
    ))
  ) {
    return;
  }
});
