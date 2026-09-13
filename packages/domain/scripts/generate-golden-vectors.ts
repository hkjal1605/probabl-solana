import { resolve } from "node:path";
import { encodeAbiParameters, encodePacked, keccak256 } from "viem";

import { computeMarketId } from "../src/market.ts";
import { quoteForExecution, quoteForReservation } from "../src/math.ts";
import { hashOrder } from "../src/order.ts";
import {
  Branch,
  FundingKind,
  POLYGON_CHAIN_ID,
  PROTOCOL_VERSION,
  Side,
  TimeInForce,
} from "../src/types.ts";

const market = {
  baseToken: "0x1111111111111111111111111111111111111111",
  polymarketConditionId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  polymarketNoIndex: 2n,
  polymarketYesIndex: 1n,
  polygonChainId: POLYGON_CHAIN_ID,
  protocolVersion: PROTOCOL_VERSION,
  quoteToken: "0x2222222222222222222222222222222222222222",
  robinhoodChainId: 31_337n,
  rulesHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tradingCutoff: 1_800_086_400n,
  tradingOpen: 1_800_000_000n,
} as const;
const marketId = computeMarketId(market);
const questionId = keccak256(
  encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }],
    ["CONDITIONAL_STOCKS_V2", marketId],
  ),
);
const resolutionController = "0x6666666666666666666666666666666666666666";
const conditionId = keccak256(
  encodePacked(["address", "bytes32", "uint256"], [resolutionController, questionId, 2n]),
);
const exchange = "0x3333333333333333333333333333333333333333";
const order = {
  maxFeeBps: 100,
  branch: Branch.Yes,
  expiry: 1_800_080_000n,
  fundingKind: FundingKind.WholeCollateral,
  limitPriceRawX18: 210_130_000n,
  maker: "0x4444444444444444444444444444444444444444",
  marketId,
  nonce: 7n,
  quantity: 1_234_567_890_123_456_789n,
  recipient: "0x5555555555555555555555555555555555555555",
  salt: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  side: Side.Buy,
  tif: TimeInForce.Gtc,
} as const;
const orderHash = hashOrder(order, {
  chainId: market.robinhoodChainId,
  verifyingContract: exchange,
});
const mathQuantity = 1_234_567_890_123_456_789n;
const mathPrice = 210_130_001n;

const fixture = {
  condition: { conditionId, questionId, resolutionController },
  market: { expectedMarketId: marketId, inputs: market },
  math: {
    executionQuote: quoteForExecution(mathQuantity, mathPrice),
    priceRawX18: mathPrice,
    quantity: mathQuantity,
    reservationQuote: quoteForReservation(mathQuantity, mathPrice),
  },
  order: { exchange, expectedOrderHash: orderHash, inputs: order },
  schemaVersion: 2,
  priceFormat: "raw-unit-ratio-x18",
  baseTokenDecimals: 18,
  quoteTokenDecimals: 6,
};
const serialized = JSON.stringify(
  fixture,
  (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  2,
);
await Bun.write(resolve(import.meta.dir, "../fixtures/golden-vectors.json"), `${serialized}\n`);
