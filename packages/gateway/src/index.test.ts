import { describe, expect, test } from "bun:test";
import { Branch, FundingKind, Side, TimeInForce } from "@conditional-stocks/domain";
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";

import {
  fundingRequirement,
  GatewayError,
  parseAtomicPlan,
  parseOrder,
  payoffPreview,
  preparedOrder,
  type ValidationSnapshot,
} from "./index.ts";

const maker = getAddress("0x1000000000000000000000000000000000000001");
const exchange = getAddress("0x2000000000000000000000000000000000000002");
const ctf = getAddress("0x3000000000000000000000000000000000000003");
const base = getAddress("0x4000000000000000000000000000000000000004");
const quote = getAddress("0x5000000000000000000000000000000000000005");
const marketId = `0x${"11".repeat(32)}` as Hex;
const salt = `0x${"22".repeat(32)}` as Hex;

const wire = {
  branch: Branch.Yes,
  expiry: "1900",
  fundingKind: FundingKind.WholeCollateral,
  limitPriceRawX18: "200000000000000000000",
  maker,
  marketId,
  nonce: "7",
  quantity: "1000000000000000000",
  recipient: maker,
  salt,
  side: Side.Buy,
  tif: TimeInForce.Gtc,
};

const snapshot: ValidationSnapshot = {
  safeBlockHash: `0x${"11".repeat(32)}`,
  chainId: 31337n,
  market: {
    baseTokenDecimals: 18,
    quoteTokenDecimals: 18,
    protocolVersion: 2,
    priceFormat: "raw-unit-ratio-x18",
    baseStep: 10n ** 15n,
    baseToken: base,
    conditionId: `0x${"33".repeat(32)}`,
    conditionalTokens: ctf,
    maxMarketOpenNotional: 10_000n * 10n ** 18n,
    maxOrderNotional: 1_000n * 10n ** 18n,
    maxOrderQuantity: 10n * 10n ** 18n,
    maxWalletOpenNotional: 2_000n * 10n ** 18n,
    minNotional: 10n ** 18n,
    priceTickRawX18: 10n ** 16n,
    quoteNoPositionId: 2n,
    quoteToken: quote,
    quoteYesPositionId: 1n,
    state: 2,
    stockNoPositionId: 4n,
    stockYesPositionId: 3n,
    tradingCutoff: 2_000n,
    tradingOpen: 1_000n,
  },
  marketOpenNotional: 0n,
  minimumNonce: 7n,
  nextSequence: 10n,
  safeBlockNumber: 100n,
  safeBlockTimestamp: 1_500n,
  tradingPaused: false,
  walletOpenNotional: 0n,
};

describe("gateway domain", () => {
  test("atomic wire plans derive totals and reject malformed, oversized or noncrossing legs", () => {
    const taker = parseOrder(wire);
    const resting = { ...wire, side: Side.Sell };
    const plan = {
      guard: { nextSequence: "10", makerFeeBps: 0, takerFeeBps: 0 },
      releaseOrders: [],
      makers: [resting],
      quantities: [wire.quantity],
      expectedRemaining: [wire.quantity],
      deadline: "1560",
    };
    const parsed = parseAtomicPlan({ ...plan, filledQuantity: "0", executionQuote: "1" }, taker);
    expect(parsed.filledQuantity).toBe(taker.quantity);
    expect(parsed.remainingQuantity).toBe(0n);
    expect(parsed.executionQuote).toBe(200n * 10n ** 18n);
    expect(
      parseAtomicPlan(
        { ...plan, makers: [], quantities: [], expectedRemaining: [], deadline: "1560" },
        taker,
      ).remainingQuantity,
    ).toBe(taker.quantity);
    for (const patch of [
      { makers: null },
      { quantities: {} },
      { expectedRemaining: [] },
      { makers: Array(33).fill(resting) },
      { deadline: "0" },
      { deadline: "1901" },
      { deadline: (1n << 64n).toString() },
      ...[0, "-1", "01", "1.1", "1e18", "0x10", (1n << 128n).toString(), "9".repeat(10000)].map(
        (value) => ({ quantities: [value] }),
      ),
      { quantities: ["0"] },
      { quantities: [(taker.quantity + 1n).toString()] },
      { expectedRemaining: ["0"] },
      { expectedRemaining: [(taker.quantity + 1n).toString()] },
      {
        makers: [resting, resting],
        quantities: ["1", "1"],
        expectedRemaining: [wire.quantity, wire.quantity],
      },
      ...[
        { side: Side.Buy },
        { branch: Branch.No },
        { tif: TimeInForce.Ioc },
        { marketId: salt },
        { limitPriceRawX18: (taker.limitPriceRawX18 + 1n).toString() },
        { limitPriceRawX18: "0" },
      ].map((value) => ({ makers: [{ ...resting, ...value }] })),
      { makers: [{ ...resting, limitPriceRawX18: "1" }], quantities: ["1"] },
    ])
      expect(() => parseAtomicPlan({ ...plan, ...patch }, taker)).toThrow();
    for (const invalid of [null, [], "plan"])
      expect(() => parseAtomicPlan(invalid, taker)).toThrow();
    const sell = { ...taker, side: Side.Sell };
    expect(parseAtomicPlan({ ...plan, makers: [wire] }, sell).executionQuote).toBe(
      parsed.executionQuote,
    );
    expect(() =>
      parseAtomicPlan({ ...plan, makers: [{ ...wire, limitPriceRawX18: "1" }] }, sell),
    ).toThrow();
  });
  test("fee caps are exact and signature-bound without extra funding", () => {
    expect(parseOrder(wire).maxFeeBps).toBe(0);
    for (const value of [-1, 1001, 65535, 0.1, "100", Number.NaN, Infinity]) {
      expect(() => parseOrder({ ...wire, maxFeeBps: value })).toThrow("maxFeeBps");
    }
    const order = parseOrder({ ...wire, maxFeeBps: 125 });
    const funding = {
      allowance: 1_000n * 10n ** 18n,
      approvedForAll: true,
      balance: 1_000n * 10n ** 18n,
    };
    const prepared = preparedOrder(order, snapshot, exchange, funding);
    const other = preparedOrder({ ...order, maxFeeBps: 126 }, snapshot, exchange, funding);
    expect(prepared.orderHash).not.toBe(other.orderHash);
    expect(prepared.fees.maxFeeBps).toBe(125);
    expect(prepared.fees.asset).toBe("stock-claims");
    expect(prepared.funding.amount).toBe(200n * 10n ** 18n);
  });
  test("stock18/USDG6 funding and claims remain raw for both branches, sides and funding modes", () => {
    const mixed = {
      ...snapshot,
      market: {
        ...snapshot.market,
        quoteTokenDecimals: 6,
        priceTickRawX18: 10_000n,
        minNotional: 10_000n,
        maxOrderNotional: 1_000_000_000n,
        maxWalletOpenNotional: 2_000_000_000n,
        maxMarketOpenNotional: 10_000_000_000n,
      },
    };
    for (const branch of [Branch.Yes, Branch.No])
      for (const side of [Side.Buy, Side.Sell])
        for (const fundingKind of [FundingKind.WholeCollateral, FundingKind.ActiveClaim]) {
          const order = parseOrder({
            ...wire,
            branch,
            side,
            fundingKind,
            limitPriceRawX18: "200000000",
          });
          const result = preparedOrder(order, mixed, exchange, {
            allowance: 0n,
            approvedForAll: false,
            balance: 10n ** 25n,
          });
          expect(result.notional).toBe(200_000_000n);
          expect(result.funding.amount).toBe(side === Side.Buy ? 200_000_000n : 10n ** 18n);
          expect(result.funding.decimals).toBe(side === Side.Buy ? 6 : 18);
          expect(result.typedData.message.limitPriceRawX18).toBe(200_000_000n);
          expect(result.typedData.domain.version).toBe("3");
          for (const output of result.payoff.outputsAtLimit) {
            const isQuote = output.tokenId === 1n || output.tokenId === 2n;
            expect(output.amount).toBe(isQuote ? 200_000_000n : 10n ** 18n);
            expect(output.decimals).toBe(isQuote ? 6 : 18);
          }
        }
  });

  test("rejects legacy wire prices and missing or legacy unit metadata", () => {
    const { limitPriceRawX18, ...legacy } = wire;
    expect(() => parseOrder({ ...legacy, limitPriceX18: limitPriceRawX18 })).toThrow();
    for (const market of [
      { ...snapshot.market, protocolVersion: 1 },
      { ...snapshot.market, quoteTokenDecimals: undefined },
      { ...snapshot.market, priceFormat: "whole-token-x18" },
    ]) {
      expect(() =>
        preparedOrder(parseOrder(wire), { ...snapshot, market } as ValidationSnapshot, exchange, {
          allowance: 0n,
          approvedForAll: null,
          balance: 0n,
        }),
      ).toThrow();
    }
  });

  test("builds exact EIP-712, reservation, approval, and payoff data", () => {
    const order = parseOrder(wire);
    const preparation = preparedOrder(order, snapshot, exchange, {
      allowance: 0n,
      approvedForAll: null,
      balance: 1_000n * 10n ** 18n,
    });
    expect(preparation.notional).toBe(200n * 10n ** 18n);
    expect(preparation.funding.amount).toBe(preparation.notional);
    expect(preparation.funding.assetAddress).toBe(quote);
    expect(preparation.typedData.domain).toEqual({
      chainId: 31337n,
      name: "ConditionalExchange",
      verifyingContract: exchange,
      version: "3",
    });
    const approval = preparation.funding.approvalCall;
    if (!approval) throw new Error("expected approval");
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toEqual({
      args: [exchange, 200n * 10n ** 18n],
      functionName: "approve",
    });
    expect(preparation.payoff.outputsAtLimit.map((item) => item.tokenId)).toEqual([3n, 2n]);
  });

  test("uses CTF active claims and retains their complement", () => {
    const order = parseOrder({ ...wire, fundingKind: FundingKind.ActiveClaim });
    const funding = fundingRequirement(order, snapshot.market, exchange, {
      allowance: null,
      approvedForAll: true,
      balance: 300n * 10n ** 18n,
    });
    expect(funding).toMatchObject({
      approved: true,
      assetAddress: ctf,
      assetKind: "erc1155",
      tokenId: 1n,
    });
    expect(payoffPreview(order, snapshot.market).retainedComplement?.tokenId).toBe(2n);
  });

  test("previews bid reservation up and execution claims down", () => {
    const whole = payoffPreview(
      parseOrder({ ...wire, limitPriceRawX18: "500000000000000000", quantity: "3" }),
      snapshot.market,
    );
    expect(whole.escrow.amount).toBe(2n);
    expect(whole.outputsAtLimit[1]?.amount).toBe(1n);
    const active = payoffPreview(
      parseOrder({
        ...wire,
        fundingKind: FundingKind.ActiveClaim,
        limitPriceRawX18: "500000000000000000",
        quantity: "3",
      }),
      snapshot.market,
    );
    expect(active.retainedComplement?.amount).toBe(2n);
  });

  test("rejects unsafe numeric JSON and exact cap/tick violations", () => {
    expect(() => parseOrder({ ...wire, quantity: 1 })).toThrow(GatewayError);
    expect(() =>
      preparedOrder(
        parseOrder({ ...wire, limitPriceRawX18: "200000000000000000001" }),
        snapshot,
        exchange,
        { allowance: 0n, approvedForAll: null, balance: 0n },
      ),
    ).toThrow("violates market terms");
    expect(() =>
      preparedOrder(
        parseOrder(wire),
        { ...snapshot, walletOpenNotional: 1_900n * 10n ** 18n },
        exchange,
        { allowance: 0n, approvedForAll: null, balance: 0n },
      ),
    ).not.toThrow(); // Aggregate caps are evaluated after the complete atomic plan is known.
  });
});
