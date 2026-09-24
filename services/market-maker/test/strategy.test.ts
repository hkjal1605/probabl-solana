import { expect, test } from "bun:test";
import {
  baseRaw,
  bn,
  legBit,
  multiplierBits,
  quote,
  singleBase,
  UNIT_MULTIPLIER,
  WAD,
  U128_MAX,
} from "@conditional-stocks/solana-client";
import { BPS, PROB, abs, decimal, units, settings } from "../src/config";
import {
  equity,
  fairPrices,
  needsReplace,
  quotes,
  shareUnits,
  tradableMask,
  type Book,
  type Quote,
} from "../src/strategy";
import { balances, config, legs, market, paused, policy, reference, seeded } from "./fixtures";
const input = () => ({
  market,
  reference,
  gapBps: policy.gapBps,
  balances: seeded(),
  legs: legs(),
  targetShares: 3_000_000n,
  orderQuote: 25_000_000n,
  makerBps: 10,
  movementBps: 0n,
  settings: config,
  best: [{}, {}] as Book,
});
const ladders = (result: Quote[]) => {
  const groups = new Map<string, Quote[]>();
  for (const q of result) {
    const id = `${q.branch}:${q.side}:${q.bases}`;
    groups.set(id, [...(groups.get(id) ?? []), q]);
  }
  return groups;
};
test("paired fair values preserve weighted spot at all probabilities and both gap signs", () => {
  for (const gap of [-7500, -1000, 0, 1000, 7500])
    for (let p = 1n; p < PROB; p += 997n)
      for (const spot of [1n, 101n, WAD, 123456789012345678901n]) {
        const [yes, no] = fairPrices(spot, p, gap);
        expect(yes > 0n && no > 0n).toBe(true);
        expect(abs(p * yes + (PROB - p) * no - spot * PROB) < PROB).toBe(true);
      }
  expect(fairPrices(WAD, 500000n, 0)).toEqual([WAD, WAD]);
  for (const p of [0n, PROB]) expect(() => fairPrices(WAD, p, 0)).toThrow();
  expect(() => fairPrices(U128_MAX, 500000n, 7500)).toThrow();
});
test("exact decimal/scientific conversion handles unequal mint precision without float amount math", () => {
  expect(decimal("1.23e-7", 18)).toBe(123000000000n);
  expect(decimal("2e+2", 6)).toBe(200000000n);
  expect(units("9007199254.740993", 6)).toBe(9007199254740993n);
  for (const v of ["-1", "NaN", "Infinity", "01", "1e999"]) expect(() => decimal(v, 18)).toThrow();
  expect(() => units("1.001", 2)).toThrow();
  expect(() => units("18446744073709551616", 0)).toThrow();
});
test("share conversion is the exact inverse of the SDK's rounded-up reservation", () => {
  const multipliers = [
    UNIT_MULTIPLIER,
    multiplierBits(1.0017),
    multiplierBits(1.1),
    multiplierBits(0.83),
    multiplierBits(1.25),
  ];
  for (const multiplier of multipliers)
    for (const scale of [1n, 100n, 1000n])
      for (const raw of [0n, 1n, 99n, 100n, 101n, 999_999n, 123_456_789n, 10n ** 15n + 7n]) {
        const shares = shareUnits(raw, scale, multiplier);
        // Every share unit is backed, and one more would not be.
        expect(baseRaw(shares, scale, multiplier, true)).toBeLessThanOrEqual(raw);
        expect(baseRaw(shares + 1n, scale, multiplier, true)).toBeGreaterThan(raw);
      }
  // One NVDAx (8 decimals) at a 1.1 dividend multiplier is 1.1 shares.
  expect(shareUnits(100_000_000n, 100n, multiplierBits(1.1))).toBe(1_100_000n);
  expect(shareUnits(1_000_000_000n, 1000n, UNIT_MULTIPLIER)).toBe(1_000_000n);
  expect(() => shareUnits(-1n, 100n, UNIT_MULTIPLIER)).toThrow();
});
test("one consolidated bid per level accepts every tradable issuer; asks deliver one issuer each", () => {
  const i = input(),
    result = quotes(i),
    fair = fairPrices(reference.spot, reference.probability, i.gapBps);
  expect(result).toHaveLength(8);
  for (const branch of [0, 1]) {
    const bids = result.filter((q) => q.branch === branch && q.side === 0),
      asks = result.filter((q) => q.branch === branch && q.side === 1);
    expect(bids.map((q) => q.bases)).toEqual([7]);
    expect(asks.map((q) => q.bases).sort()).toEqual([legBit(1), legBit(2), legBit(3)]);
    // Same economic share, same price on every issuer.
    expect(new Set(asks.map((q) => q.price)).size).toBe(1);
    expect(asks.reduce((sum, q) => sum + quote(q.quantity, q.price, true), 0n)).toBeLessThanOrEqual(
      i.orderQuote,
    );
  }
  for (const q of result) {
    expect(q.price % BigInt(market.terms.tick.toString())).toBe(0n);
    expect(q.quantity % BigInt(market.terms.step.toString())).toBe(0n);
    expect(quote(q.quantity, q.price, true) <= i.orderQuote).toBe(true);
    expect(q.side === 0 ? q.price < fair[q.branch] : q.price > fair[q.branch]).toBe(true);
    expect(
      q.side === 0
        ? q.price * BPS <= fair[q.branch] * (BPS - BigInt(i.makerBps))
        : q.price * (BPS - BigInt(i.makerBps)) >= fair[q.branch] * BPS,
    ).toBe(true);
  }
});
test("halted legs get no asks and leave the consolidated bid's accepted set", () => {
  const i = input();
  i.legs = legs({ 2: paused });
  expect(tradableMask(market.bases, i.legs)).toBe(0b101);
  const result = quotes(i);
  expect(result.filter((q) => q.side === 0).every((q) => q.bases === 0b101)).toBe(true);
  expect(result.some((q) => q.side === 1 && q.bases === legBit(2))).toBe(false);
  expect(result.filter((q) => q.side === 1)).toHaveLength(4);
  // With every issuer halted there is nothing to buy or deliver.
  i.legs = legs({ 1: paused, 2: paused, 3: { tradable: false, halt: "corporate-action" } });
  expect(quotes(i)).toEqual([]);
});
test("per-issuer asks are sized by that issuer's claims at its live multiplier", () => {
  const i = input();
  // 0.0095 NVDAx: 9500 share units at 1.0 (below one lot), 10450 at a 1.1 multiplier.
  i.balances = balances(1_000_000_000n, [950_000n]);
  i.targetShares = 10_000n;
  i.legs = legs();
  expect(quotes(i).filter((q) => q.side === 1)).toEqual([]);
  const accrued = multiplierBits(1.1);
  i.legs = legs({ 1: { multiplier: accrued } });
  const asks = quotes(i).filter((q) => q.side === 1);
  expect(asks).toHaveLength(2);
  for (const q of asks) {
    expect(q.bases).toBe(legBit(1));
    expect(q.quantity).toBe(10_000n);
    expect(baseRaw(q.quantity, 100n, accrued, true)).toBeLessThanOrEqual(950_000n);
  }
  // A multi-level ladder never reserves more raw claims than the leg holds.
  i.settings = settings({ markets: [policy], quoteLevels: 3, levelSpacingBps: 40 });
  i.balances = balances(1_000_000_000n, [3_050_000n]);
  i.orderQuote = 6_000_000n;
  const ladder = quotes(i).filter((q) => q.side === 1 && q.branch === 0);
  expect(ladder.length).toBeGreaterThan(1);
  expect(
    ladder.reduce((sum, q) => sum + baseRaw(q.quantity, 100n, accrued, true), 0n),
  ).toBeLessThanOrEqual(3_050_000n);
});
test("fragmented issuer inventory quotes each fragment separately and sizes budget by holdings", () => {
  const i = input();
  // YES branch: 0.6 NVDAx, 0.3 NVDAon, 0.005 NVDAr (below one lot).
  i.balances = balances(1_000_000_000n);
  i.balances[4] = 60_000_000n;
  i.balances[7] = 300_000_000n;
  i.balances[10] = 5_000_000n;
  i.orderQuote = 250_000_000n;
  const asks = quotes(i).filter((q) => q.side === 1 && q.branch === 0);
  expect(asks.map((q) => singleBase(q.bases))).toEqual([1, 2]);
  const [x, on] = asks;
  expect(x!.quantity).toBeLessThanOrEqual(600_000n);
  expect(on!.quantity).toBeLessThanOrEqual(300_000n);
  // Twice the holdings, about twice the displayed size.
  expect(x!.quantity).toBeGreaterThan(on!.quantity);
  // Every fragment counts toward the branch position: room is 2 x 3 - 0.905 shares.
  const bid = quotes(i).find((q) => q.side === 0 && q.branch === 0)!;
  expect(bid.bases).toBe(7);
  expect(bid.quantity).toBeLessThanOrEqual(6_000_000n - 905_000n);
});
test("multi-level ladders use distinct prices without multiplying the per-side budget", () => {
  const i = input();
  i.settings = settings({
    markets: [policy],
    quoteLevels: 3,
    levelSpacingBps: 40,
  });
  const result = quotes(i),
    groups = ladders(result);
  expect(result).toHaveLength(24);
  expect(groups.size).toBe(8);
  for (const ladder of groups.values()) {
    expect(ladder.map((q) => q.level)).toEqual([0, 1, 2]);
    expect(new Set(ladder.map((q) => q.price)).size).toBe(3);
    expect(new Set(ladder.map((q) => q.quantity)).size).toBeGreaterThan(1);
  }
  for (const branch of [0, 1] as const)
    for (const side of [0, 1] as const) {
      const all = result.filter((q) => q.branch === branch && q.side === side);
      expect(all.reduce((sum, q) => sum + quote(q.quantity, q.price, true), 0n)).toBeLessThanOrEqual(
        i.orderQuote,
      );
    }
});
test("market max-order limits each ladder order rather than the whole side", () => {
  const i = input();
  i.settings = settings({
    markets: [policy],
    quoteLevels: 3,
    levelSpacingBps: 40,
  });
  i.market = {
    ...market,
    terms: { ...market.terms, max_order: bn(1_800_000) },
  } as typeof market;
  const result = quotes(i);
  expect(result.filter((q) => q.side === 0)).toHaveLength(6);
  expect(result.every((q) => quote(q.quantity, q.price, true) <= 1_800_000n)).toBe(true);
  for (const branch of [0, 1] as const) {
    const bids = result.filter((q) => q.branch === branch && q.side === 0);
    expect(bids.reduce((sum, q) => sum + quote(q.quantity, q.price, true), 0n)).toBeGreaterThan(
      1_800_000n,
    );
  }
});
test("missing inventory never produces unbacked quotes; inventory caps stop accumulating buys", () => {
  const i = input();
  i.balances.fill(0n);
  expect(quotes(i)).toEqual([]);
  // Two shares of YES on every issuer: twice the target, so no YES bids.
  i.balances = balances(0n);
  i.balances[1] = 1_000_000_000n;
  i.balances[4] = 200_000_000n;
  i.balances[7] = i.balances[10] = 2_000_000_000n;
  i.balances[5] = 100_000_000n;
  expect(quotes(i).every((q) => q.side === 1)).toBe(true);
  i.balances[4] = 190_000_000n;
  expect(
    quotes(i)
      .filter((q) => q.branch === 0 && q.side === 0)
      .every((q) => q.quantity <= 100_000n),
  ).toBe(true);
});
test("do not cross external books per issuer; uncertainty/risk can suppress quotes", () => {
  const i = input(),
    crossed = { bid: 200n * WAD, ask: 50n * WAD };
  i.best = [
    { 1: crossed, 2: crossed, 3: crossed },
    { 1: crossed, 2: crossed, 3: crossed },
  ];
  expect(quotes(i)).toEqual([]);
  // A cheap NVDAon ask crosses the consolidated bid, which accepts NVDAon...
  i.best = [{ 2: { ask: 50n * WAD } }, {}];
  expect(quotes(i).some((q) => q.branch === 0 && q.side === 0)).toBe(false);
  // ...unless NVDAon is halted and the bid no longer accepts it.
  i.legs = legs({ 2: paused });
  expect(quotes(i).find((q) => q.branch === 0 && q.side === 0)?.bases).toBe(0b101);
  // A rich bid accepting only NVDAx suppresses only NVDAx asks.
  i.legs = legs();
  i.best = [{ 1: { bid: 200n * WAD } }, {}];
  const asks = quotes(i).filter((q) => q.branch === 0 && q.side === 1);
  expect(asks.map((q) => q.bases).sort()).toEqual([legBit(2), legBit(3)]);
  i.best = [{}, {}];
  i.movementBps = 1000n;
  expect(quotes(i)).toEqual([]);
  i.movementBps = 0n;
  i.market = { ...market, terms: { ...market.terms, min_notional: bn(100000000) } };
  expect(quotes(i)).toEqual([]);
});
test("equity marks issuer claims in shares at the live multiplier", () => {
  const b = seeded(),
    base = equity(b, reference, policy.gapBps, market.bases, legs());
  // 1000 USDC per branch, three shares per branch at $100: 1300 USDC.
  expect(base).toBe(1_300_000_000n);
  const accrued = equity(
    b,
    reference,
    policy.gapBps,
    market.bases,
    legs({ 1: { multiplier: multiplierBits(1.1) } }),
  );
  expect(accrued).toBe(1_310_000_000n);
  expect(() => equity(b, reference, policy.gapBps, market.bases, {})).toThrow();
});
test("repricing hysteresis retains priority but refreshes expiry and material moves", () => {
  const q = quotes(input())[0]!,
    old = { price: q.price, remaining: q.quantity, expiry: 1000n };
  expect(needsReplace(old, q, 1n, config)).toBe(false);
  expect(needsReplace(old, q, 980n, config)).toBe(true);
  expect(needsReplace({ ...old, price: (q.price * 101n) / 100n }, q, 1n, config)).toBe(true);
});
test("configuration is fail-closed for missing unit review, duplicate markets/issuers and unsafe refresh policies", () => {
  expect(settings({ markets: [] }).markets).toEqual([]);
  expect(settings({ markets: [], quoteLevels: 10, ttlSeconds: 86400 }).quoteLevels).toBe(10);
  // A quote-only maker: no issuer seed, an explicit target position.
  const quoteOnly = { ...policy, baseInventories: ["0", "0", "0"], targetShares: "10" };
  expect(settings({ markets: [quoteOnly] }).markets[0]!.targetShares).toBe("10");
  const xOnly = { ...policy, referenceMints: [policy.baseMints[0]!] };
  expect(settings({ markets: [xOnly] }).markets[0]!.referenceMints).toEqual([policy.baseMints[0]!]);
  for (const input of [
    { markets: [policy, policy] },
    { markets: [{ ...policy, basePriceMultipliers: undefined }] },
    { markets: [{ ...policy, basePriceMultipliers: ["1", "1"] }] },
    { markets: [{ ...policy, baseInventories: ["1", "1"] }] },
    { markets: [{ ...policy, baseInventories: ["1", "-1", "1"] }] },
    { markets: [{ ...policy, baseMints: [] }] },
    { markets: [{ ...policy, baseMints: [policy.baseMints[0], policy.baseMints[0], policy.baseMints[2]] }] },
    { markets: [{ ...policy, baseMints: [policy.quoteMint, ...policy.baseMints.slice(1)] }] },
    {
      markets: [
        {
          ...policy,
          baseMints: [...policy.baseMints, policy.market],
          baseInventories: ["1", "1", "1", "1"],
          basePriceMultipliers: ["1", "1", "1", "1"],
        },
      ],
    },
    { markets: [{ ...quoteOnly, targetShares: undefined }] },
    { markets: [{ ...policy, referenceMints: [] }] },
    { markets: [{ ...policy, referenceMints: [policy.quoteMint] }] },
    { markets: [{ ...policy, referenceMints: [policy.baseMints[0], policy.baseMints[0]] }] },
    { markets: [{ ...policy, referenceMints: policy.baseMints[0] }] },
    { markets: [{ ...quoteOnly, targetShares: "0" }] },
    { markets: [policy], pollMs: 60000, ttlSeconds: 30 },
    { markets: [policy], quoteLevels: 5, levelSpacingBps: 500, maxHalfSpreadBps: 1000 },
    { markets: [policy], halfSpreadBps: NaN },
    { markets: [policy], maxLegDispersionBps: 0 },
    { markets: [{ ...policy, orderQuote: "1000" }] },
  ])
    expect(() => settings(input)).toThrow();
});

test("fee margins compensate net received assets even at the protocol's maximum maker fee", () => {
  for (const makerBps of [0, 1, 100, 500, 1000]) {
    const i = { ...input(), makerBps },
      result = quotes(i),
      fair = fairPrices(reference.spot, reference.probability, i.gapBps);
    expect(result).toHaveLength(8);
    for (const q of result)
      expect(
        q.side === 0
          ? q.price * BPS <= fair[q.branch] * (BPS - BigInt(makerBps))
          : q.price * (BPS - BigInt(makerBps)) >= fair[q.branch] * BPS,
      ).toBe(true);
  }
});
