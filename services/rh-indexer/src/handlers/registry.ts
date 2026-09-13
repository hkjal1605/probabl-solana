import {
  insertMarket,
  persistProtocolEvent,
  updateMarket,
  ZERO_HASH,
} from "@conditional-stocks/db/indexer/writes";
import { assertMarketUnits, PRICE_FORMAT } from "@conditional-stocks/domain";
import { erc20Abi } from "viem";
import { ponder } from "../observability.ts";

ponder.on("MarketRegistry:MarketCreated", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "MarketRegistry",
      "MarketCreated",
      event,
    ))
  ) {
    return;
  }
  const args = event.args;
  const [baseTokenDecimals, quoteTokenDecimals] = await Promise.all([
    context.client.readContract({
      abi: erc20Abi,
      address: args.baseToken,
      functionName: "decimals",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: args.quoteToken,
      functionName: "decimals",
    }),
  ]);
  const units = {
    baseTokenDecimals,
    quoteTokenDecimals,
    protocolVersion: args.protocolVersion,
    priceFormat: PRICE_FORMAT,
  };
  assertMarketUnits(units);
  await insertMarket(context.db, {
    ...units,
    id: args.marketId,
    baseToken: args.baseToken,
    conditionId: args.conditionId,
    createdBlock: event.block.number,
    localQuestionId: args.localQuestionId,
    metadataHash: args.metadataHash,
    metadataUri: args.metadataUri,
    polymarketConditionId: args.polymarketConditionId,
    quoteToken: args.quoteToken,
    rulesHash: args.rulesHash,
    state: 0,
    stateReasonHash: ZERO_HASH,
    updatedBlock: event.block.number,
  });
});

ponder.on("MarketRegistry:MarketTermsConfigured", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "MarketRegistry",
      "MarketTermsConfigured",
      event,
    ))
  ) {
    return;
  }
  const args = event.args;
  await updateMarket(context.db, args.marketId, {
    baseStep: args.baseStep,
    maxMarketOpenNotional: args.maxMarketOpenNotional,
    maxOrderNotional: args.maxOrderNotional,
    maxOrderQuantity: args.maxOrderQuantity,
    maxWalletOpenNotional: args.maxWalletOpenNotional,
    minNotional: args.minNotional,
    polymarketNoIndex: args.polymarketNoIndex,
    polymarketYesIndex: args.polymarketYesIndex,
    priceTickRawX18: args.priceTickRawX18,
    tradingCutoff: args.tradingCutoff,
    tradingOpen: args.tradingOpen,
    updatedBlock: event.block.number,
  });
});

ponder.on("MarketRegistry:MarketPositionsConfigured", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "MarketRegistry",
      "MarketPositionsConfigured",
      event,
    ))
  ) {
    return;
  }
  const args = event.args;
  await updateMarket(context.db, args.marketId, {
    quoteNoPositionId: args.quoteNoPositionId,
    quoteYesPositionId: args.quoteYesPositionId,
    stockNoPositionId: args.stockNoPositionId,
    stockYesPositionId: args.stockYesPositionId,
    updatedBlock: event.block.number,
  });
});

ponder.on("MarketRegistry:MarketStateChanged", async ({ event, context }) => {
  if (
    !(await persistProtocolEvent(
      context.db,
      context.chain.id,
      "MarketRegistry",
      "MarketStateChanged",
      event,
    ))
  ) {
    return;
  }
  const args = event.args;
  await updateMarket(context.db, args.marketId, {
    state: args.newState,
    stateReasonHash: args.reasonHash,
    updatedBlock: event.block.number,
  });
});

ponder.on("MarketRegistry:ResolutionControllerConfigured", async ({ event, context }) => {
  await persistProtocolEvent(
    context.db,
    context.chain.id,
    "MarketRegistry",
    "ResolutionControllerConfigured",
    event,
  );
});
