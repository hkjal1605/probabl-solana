import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { computeMarketId } from "./market.ts";
import { quoteForExecution, quoteForReservation } from "./math.ts";
import { hashOrder } from "./order.ts";
import type { Branch, FundingKind, MarketIdentity, Order, Side, TimeInForce } from "./types.ts";

interface MarketVectorInputs {
  baseToken: `0x${string}`;
  polymarketConditionId: `0x${string}`;
  polymarketNoIndex: string;
  polymarketYesIndex: string;
  polygonChainId: string;
  protocolVersion: number;
  quoteToken: `0x${string}`;
  robinhoodChainId: string;
  rulesHash: `0x${string}`;
  tradingCutoff: string;
  tradingOpen: string;
}

interface OrderVectorInputs {
  maxFeeBps: number;
  branch: number;
  expiry: string;
  fundingKind: number;
  limitPriceRawX18: string;
  maker: `0x${string}`;
  marketId: `0x${string}`;
  nonce: string;
  quantity: string;
  recipient: `0x${string}`;
  salt: `0x${string}`;
  side: number;
  tif: number;
}

interface GoldenVectors {
  market: { expectedMarketId: `0x${string}`; inputs: MarketVectorInputs };
  math: {
    executionQuote: string;
    priceRawX18: string;
    quantity: string;
    reservationQuote: string;
  };
  order: {
    exchange: `0x${string}`;
    expectedOrderHash: `0x${string}`;
    inputs: OrderVectorInputs;
  };
}

describe("committed protocol golden vectors", () => {
  test("reproduces market, order, and rounding hashes", async () => {
    const path = resolve(import.meta.dir, "../fixtures/golden-vectors.json");
    const vectors = (await Bun.file(path).json()) as GoldenVectors;
    const marketInputs = vectors.market.inputs;
    const market: MarketIdentity = {
      ...marketInputs,
      polymarketNoIndex: BigInt(marketInputs.polymarketNoIndex),
      polymarketYesIndex: BigInt(marketInputs.polymarketYesIndex),
      polygonChainId: BigInt(marketInputs.polygonChainId),
      robinhoodChainId: BigInt(marketInputs.robinhoodChainId),
      tradingCutoff: BigInt(marketInputs.tradingCutoff),
      tradingOpen: BigInt(marketInputs.tradingOpen),
    };
    const orderInputs = vectors.order.inputs;
    const order: Order = {
      ...orderInputs,
      branch: orderInputs.branch as Branch,
      expiry: BigInt(orderInputs.expiry),
      fundingKind: orderInputs.fundingKind as FundingKind,
      limitPriceRawX18: BigInt(orderInputs.limitPriceRawX18),
      nonce: BigInt(orderInputs.nonce),
      quantity: BigInt(orderInputs.quantity),
      side: orderInputs.side as Side,
      tif: orderInputs.tif as TimeInForce,
    };

    expect(computeMarketId(market)).toBe(vectors.market.expectedMarketId);
    expect(
      hashOrder(order, {
        chainId: market.robinhoodChainId,
        verifyingContract: vectors.order.exchange,
      }),
    ).toBe(vectors.order.expectedOrderHash);
    expect(quoteForExecution(BigInt(vectors.math.quantity), BigInt(vectors.math.priceRawX18))).toBe(
      BigInt(vectors.math.executionQuote),
    );
    expect(
      quoteForReservation(BigInt(vectors.math.quantity), BigInt(vectors.math.priceRawX18)),
    ).toBe(BigInt(vectors.math.reservationQuote));
  });
});
