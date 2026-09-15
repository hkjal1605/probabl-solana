import { expect, test } from "bun:test";
import { bn, quote, WAD, U128_MAX } from "@conditional-stocks/solana-client";
import { BPS, PROB, abs, decimal, units, settings } from "../src/config";
import { fairPrices, quotes, needsReplace } from "../src/strategy";
import { config, market, policy, reference } from "./fixtures";
const input = () => ({
  market,
  reference,
  gapBps: policy.gapBps,
  balances: [0n, 0n, 100000000n, 100000000n, 100000000n, 100000000n],
  targetBase: 100000000n,
  orderQuote: 5000000n,
  makerBps: 10,
  movementBps: 0n,
  settings: config,
  best: [{}, {}] as [{ bid?: bigint; ask?: bigint }, { bid?: bigint; ask?: bigint }],
});
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
test("quotes round outward, respect tick/step, inventory, notional and fee margins", () => {
  const i = input(),
    result = quotes(i),
    fair = fairPrices(reference.spot, reference.probability, i.gapBps);
  expect(result).toHaveLength(4);
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
test("multi-level ladders use distinct prices without multiplying the per-side budget", () => {
  const i = input();
  i.settings = settings({
    markets: [policy],
    quoteLevels: 3,
    levelSpacingBps: 40,
  });
  const result = quotes(i);
  expect(result).toHaveLength(12);
  for (const branch of [0, 1] as const)
    for (const side of [0, 1] as const) {
      const ladder = result.filter((q) => q.branch === branch && q.side === side);
      expect(ladder.map((q) => q.level)).toEqual([0, 1, 2]);
      expect(new Set(ladder.map((q) => q.price)).size).toBe(3);
      expect(ladder.reduce((sum, q) => sum + quote(q.quantity, q.price, true), 0n)).toBeLessThanOrEqual(
        i.orderQuote,
      );
      if (side === 1)
        expect(ladder.reduce((sum, q) => sum + q.quantity, 0n)).toBeLessThanOrEqual(
          i.balances[2 + branch]!,
        );
    }
});
test("missing inventory never produces unbacked quotes; inventory caps stop accumulating buys", () => {
  const i = input();
  i.balances.fill(0n);
  expect(quotes(i)).toEqual([]);
  i.balances = [0n, 0n, 200000000n, 100000000n, 100000000n, 0n];
  expect(quotes(i).every((q) => q.side === 1)).toBe(true);
  i.balances[2] = 190000000n;
  i.balances[4] = 100000000n;
  expect(
    quotes(i)
      .filter((q) => q.branch === 0 && q.side === 0)
      .every((q) => q.quantity <= 10000000n),
  ).toBe(true);
});
test("do not cross external books; uncertainty/risk can suppress quotes rather than cap unsafe spreads", () => {
  const i = input();
  i.best = [
    { bid: 2n * WAD, ask: WAD / 2n },
    { bid: 2n * WAD, ask: WAD / 2n },
  ];
  expect(quotes(i)).toEqual([]);
  i.best = [{}, {}];
  i.movementBps = 1000n;
  expect(quotes(i)).toEqual([]);
  i.movementBps = 0n;
  i.market = { ...market, terms: { ...market.terms, min_notional: bn(100000000) } };
  expect(quotes(i)).toEqual([]);
});
test("repricing hysteresis retains priority but refreshes expiry and material moves", () => {
  const q = quotes(input())[0]!,
    old = { price: q.price, remaining: q.quantity, expiry: 1000n };
  expect(needsReplace(old, q, 1n, config)).toBe(false);
  expect(needsReplace(old, q, 980n, config)).toBe(true);
  expect(needsReplace({ ...old, price: (q.price * 101n) / 100n }, q, 1n, config)).toBe(true);
});
test("configuration is fail-closed for missing unit review, duplicate markets and unsafe refresh policies", () => {
  expect(settings({ markets: [] }).markets).toEqual([]);
  for (const input of [
    { markets: [policy, policy] },
    { markets: [{ ...policy, basePriceMultiplier: undefined }] },
    { markets: [policy], pollMs: 60000, ttlSeconds: 30 },
    { markets: [policy], quoteLevels: 5, levelSpacingBps: 500, maxHalfSpreadBps: 1000 },
    { markets: [policy], halfSpreadBps: NaN },
    { markets: [{ ...policy, orderQuote: "100" }] },
  ])
    expect(() => settings(input)).toThrow();
});

test("fee margins compensate net received assets even at the protocol's maximum maker fee", () => {
  for (const makerBps of [0, 1, 100, 500, 1000]) {
    const i = { ...input(), makerBps },
      result = quotes(i),
      fair = fairPrices(reference.spot, reference.probability, i.gapBps);
    expect(result).toHaveLength(4);
    for (const q of result)
      expect(
        q.side === 0
          ? q.price * BPS <= fair[q.branch] * (BPS - BigInt(makerBps))
          : q.price * (BPS - BigInt(makerBps)) >= fair[q.branch] * BPS,
      ).toBe(true);
  }
});
