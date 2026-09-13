import { describe, expect, test } from "bun:test";
import { hashOrder, type Order, Side, TimeInForce } from "@conditional-stocks/domain";
import { toHex } from "viem";
import {
  atomicRestingNotional,
  type MatchCandidate,
  planAtomicOrder,
  planAtomicRecovery,
} from "../src/atomic-plan.ts";

const exchange = "0x1000000000000000000000000000000000000001";
const wallet = "0x2000000000000000000000000000000000000002";
const base: Order = {
  maker: wallet,
  recipient: wallet,
  marketId: toHex(1, { size: 32 }),
  branch: 0,
  side: 0,
  fundingKind: 0,
  quantity: 8n * 10n ** 18n,
  limitPriceRawX18: 101_000_000n,
  expiry: 2000n,
  nonce: 0n,
  salt: toHex(2, { size: 32 }),
  tif: 0,
  maxFeeBps: 200,
};
const unit = 10n ** 18n;
function candidate(
  sequence: number,
  price: bigint,
  quantity: bigint,
  override: Partial<Order> = {},
): MatchCandidate {
  const order = {
    ...base,
    side: Side.Sell,
    quantity,
    limitPriceRawX18: price,
    salt: toHex(sequence + 10, { size: 32 }),
    ...override,
  };
  return {
    order,
    orderHash: hashOrder(order, { chainId: 31337n, verifyingContract: exchange }),
    remaining: quantity,
    sequence: BigInt(sequence),
  };
}
const plan = (
  candidates: MatchCandidate[],
  overrides: Partial<Parameters<typeof planAtomicOrder>[0]> = {},
) =>
  planAtomicOrder({
    taker: base,
    candidates,
    chainId: 31337n,
    exchange,
    timestamp: 1500n,
    baseStep: 10n ** 15n,
    nextSequence: 100n,
    makerFeeBps: 100,
    takerFeeBps: 200,
    ...overrides,
  });

describe("stateless atomic price/FIFO planning", () => {
  test("guard includes exact sequence and fees, deadline never outlives a selected maker", () => {
    const result = plan([candidate(1, 100_000_000n, unit, { expiry: 1501n })]);
    expect(result.deadline).toBe(1501n);
    expect(result.guard).toEqual({ nextSequence: 100n, makerFeeBps: 100, takerFeeBps: 200 });
    for (const sequence of [100n, -1n, 1n << 64n])
      expect(() => plan([{ ...candidate(1, 100_000_000n, unit), sequence }])).toThrow();
  });
  test("net resting caps credit self-makers, IOC refunds and conservative raw rounding", () => {
    const selected = plan([candidate(1, 100_000_000n, unit)]);
    expect(
      atomicRestingNotional({
        taker: base,
        plan: selected,
        marketOpenNotional: 100_000_000n,
        walletOpenNotional: 100_000_000n,
      }),
    ).toEqual({ market: 707_000_000n, wallet: 707_000_000n });
    expect(
      atomicRestingNotional({
        taker: { ...base, tif: 1 },
        plan: selected,
        marketOpenNotional: 100_000_000n,
        walletOpenNotional: 100_000_000n,
      }),
    ).toEqual({ market: 0n, wallet: 0n });
    expect(() =>
      atomicRestingNotional({
        taker: base,
        plan: selected,
        marketOpenNotional: 0n,
        walletOpenNotional: -1n,
      }),
    ).toThrow();
  });
  test("stale recovery prioritizes wallet space, is bounded, and rejects corrupt accounting", () => {
    const own = {
      orderHash: toHex(1, { size: 32 }),
      maker: wallet as `0x${string}`,
      marketId: base.marketId,
      openNotional: 1n,
    };
    const foreign = { ...own, maker: exchange as `0x${string}`, orderHash: toHex(2, { size: 32 }) };
    const input = {
      taker: base,
      resting: { market: 3n, wallet: 2n },
      maxMarketOpenNotional: 2n,
      maxWalletOpenNotional: 1n,
      candidates: [foreign, own],
    };
    expect(planAtomicRecovery(input)).toEqual({
      market: 2n,
      wallet: 1n,
      releaseOrders: [own.orderHash],
    });
    expect(() => planAtomicRecovery({ ...input, candidates: [foreign] })).toThrow("caps");
    for (const bad of [
      { ...own, openNotional: 0n },
      { ...own, marketId: toHex(3, { size: 32 }) },
      { ...own, openNotional: 10n },
    ])
      expect(() => planAtomicRecovery({ ...input, candidates: [bad] })).toThrow();
    expect(() => planAtomicRecovery({ ...input, candidates: [own, own] })).toThrow();
    const candidates = Array.from({ length: 33 }, (_, i) => ({
      ...own,
      orderHash: toHex(i + 1, { size: 32 }),
    }));
    expect(
      planAtomicRecovery({ ...input, resting: { market: 33n, wallet: 33n }, candidates })
        .releaseOrders,
    ).toHaveLength(32);
    expect(() =>
      planAtomicRecovery({ ...input, resting: { market: 34n, wallet: 34n }, candidates }),
    ).toThrow("caps");
  });
  test("best asks first, oldest at each price, exact partial maker and GTC remainder", () => {
    const a = candidate(1, 100_000_000n, 3n * unit);
    const b = candidate(2, 101_000_000n, 2n * unit);
    const c = candidate(3, 101_000_000n, 10n * unit);
    const result = plan([c, b, a]);
    expect(result.makers.map((order) => order.salt)).toEqual([
      a.order.salt,
      b.order.salt,
      c.order.salt,
    ]);
    expect(result.quantities).toEqual([3n * unit, 2n * unit, 3n * unit]);
    expect(result.expectedRemaining).toEqual([3n * unit, 2n * unit, 10n * unit]);
    expect(result.executionQuote).toBe(805_000_000n);
    expect(result.remainingQuantity).toBe(0n);
    expect(plan([a, b]).remainingQuantity).toBe(3n * unit);
    expect(c.remaining).toBe(10n * unit);
  });
  test("sell selects highest bids first and retains FIFO", () => {
    const bids = [
      candidate(1, 100_000_000n, unit, { side: Side.Buy }),
      candidate(2, 102_000_000n, unit, { side: Side.Buy }),
      candidate(3, 102_000_000n, unit, { side: Side.Buy }),
    ];
    const result = plan(bids, {
      taker: { ...base, side: Side.Sell, limitPriceRawX18: 100_000_000n },
    });
    expect(result.makers.map((order) => String(order.salt))).toEqual([
      String(bids[1]?.order.salt),
      String(bids[2]?.order.salt),
      String(bids[0]?.order.salt),
    ]);
    expect(result.executionQuote).toBe(304_000_000n);
  });
  test("GTC and IOC share exact execution selection for every branch and funding combination", () => {
    for (const branch of [0, 1] as const)
      for (const fundingKind of [0, 1] as const)
        for (const makerFunding of [0, 1] as const) {
          const makers = [candidate(1, 100_000_000n, unit, { branch, fundingKind: makerFunding })];
          const gtc = plan(makers, { taker: { ...base, branch, fundingKind } });
          const ioc = plan(makers, {
            taker: { ...base, branch, fundingKind, tif: TimeInForce.Ioc },
          });
          expect(gtc).toEqual(ioc);
        }
  });
  test("expired, fee-ineligible and noncrossing makers do not consume the taker", () => {
    expect(
      plan([
        candidate(1, 100_000_000n, unit, { expiry: 1500n }),
        candidate(2, 100_000_000n, unit, { maxFeeBps: 99 }),
        candidate(3, 102_000_000n, unit),
      ]).filledQuantity,
    ).toBe(0n);
    expect(plan([]).remainingQuantity).toBe(base.quantity);
    expect(plan([], { taker: { ...base, expiry: 1520n } }).deadline).toBe(1520n);
  });
  test("32-maker bound is explicit, but a full fill before row 33 is allowed", () => {
    const rows = Array.from({ length: 33 }, (_, i) => candidate(i, 100_000_000n, unit));
    expect(plan(rows, { taker: { ...base, quantity: 32n * unit } }).makers).toHaveLength(32);
    expect(() => plan(rows, { taker: { ...base, quantity: 33n * unit } })).toThrow("more than 32");
    expect(() => plan([...rows, candidate(34, 100_000_000n, unit)])).toThrow("bounded");
  });
  test("candidate corruption and mismatched domains fail closed", () => {
    const c = candidate(1, 100_000_000n, unit);
    for (const broken of [
      { ...c, remaining: 0n },
      { ...c, remaining: unit + 1n },
      { ...c, sequence: -1n },
      { ...c, remaining: 1n },
      { ...c, orderHash: toHex(0, { size: 32 }) },
      candidate(2, 100_000_000n, unit, { branch: 1 }),
      candidate(2, 100_000_000n, unit, { side: 0 }),
      candidate(2, 100_000_000n, unit, { tif: 1 }),
      candidate(2, 100_000_000n, unit, { marketId: toHex(3, { size: 32 }) }),
    ])
      expect(() => plan([broken])).toThrow();
    expect(() => plan([c, c])).toThrow("Duplicate");
    expect(() => plan([c, { ...candidate(2, 100_000_000n, unit), sequence: 1n }])).toThrow(
      "sequence",
    );
    expect(() => plan([c], { chainId: 1n })).toThrow("canonical");
  });
  test("exact raw rounding and taker caps never become silent zero-value fills", () => {
    expect(() =>
      plan([candidate(1, 1n, 1n)], { taker: { ...base, quantity: 1n }, baseStep: 1n }),
    ).toThrow("zero quote");
    expect(() =>
      plan([candidate(1, 100_000_000n, unit)], { taker: { ...base, maxFeeBps: 199 } }),
    ).toThrow("taker fee");
    for (const patch of [
      { quantity: 0n },
      { quantity: 1n << 128n },
      { quantity: 1n },
      { expiry: 1500n },
      { limitPriceRawX18: 0n },
      { maxFeeBps: -1 },
    ])
      expect(() => plan([], { taker: { ...base, ...patch } })).toThrow();
    for (const fee of [-1, 1001, 1.5, Number.NaN])
      expect(() => plan([], { makerFeeBps: fee })).toThrow();
  });
  test("deterministic generated books conserve base and quote over 500 permutations", () => {
    for (let seed = 1; seed <= 500; ++seed) {
      const quantity = BigInt((seed % 17) + 1) * unit;
      const rows = Array.from({ length: 12 }, (_, i) =>
        candidate(
          i + 1,
          BigInt(90 + ((seed + i) % 10)) * 1_000_000n,
          BigInt(((seed * (i + 1)) % 3) + 1) * unit,
        ),
      );
      const result = plan(rows.slice().reverse(), { taker: { ...base, quantity } });
      expect(result).toEqual(plan(rows, { taker: { ...base, quantity } }));
      expect(result.filledQuantity + result.remainingQuantity).toBe(quantity);
      expect(result.quantities.reduce((a, b) => a + b, 0n)).toBe(result.filledQuantity);
      expect(result.executionQuote).toBe(
        result.makers.reduce(
          (sum, maker, i) => sum + ((result.quantities[i] ?? 0n) * maker.limitPriceRawX18) / unit,
          0n,
        ),
      );
    }
  });
});
