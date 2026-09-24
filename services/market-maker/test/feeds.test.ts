import { expect, test } from "bun:test";
import { multiplierBits, WAD } from "@conditional-stocks/solana-client";
import {
  DEVNET_ASSET_MINTS,
  SOLANA_DEVNET_GENESIS,
  SOLANA_MAINNET_GENESIS,
} from "@conditional-stocks/shared/spot-prices";
import { settings } from "../src/config";
import { apiOrigin, fetchReference, json, reference } from "../src/feeds";
import { config, feeds, legs, market, marketAccount, paused, policy } from "./fixtures";

const G = SOLANA_MAINNET_GENESIS;
const price = (f: ReturnType<typeof feeds>, index: number) => f.prices.prices[index]!;
test("price normalization is per share and honors quote USD price and reviewed raw-unit multipliers", () => {
  const f = feeds();
  const r = reference(f.source, f.prices, G, market, policy, config, legs(), f.now);
  // $100 per share, 6 share decimals, 6-decimal USDC: 100 quote raw per share unit.
  expect(r.spot).toBe(100n * WAD);
  expect(r.legs).toEqual({ 1: 100n * WAD, 2: 100n * WAD, 3: 100n * WAD });
  expect(r.probability).toBe(400000n);
  price(f, 3).priceUsd = 0.5;
  expect(
    reference(
      f.source,
      f.prices,
      G,
      market,
      { ...policy, basePriceMultipliers: ["2", "2", "2"] },
      config,
      legs(),
      f.now,
    ).spot,
  ).toBe(400n * WAD);
});
test("ScaledUiAmount legs divide the issuer token price by the live multiplier", () => {
  const f = feeds();
  // One NVDAx now represents 1.1 shares after a reinvested dividend.
  price(f, 0).priceUsd = 110;
  const r = reference(
    f.source,
    f.prices,
    G,
    market,
    policy,
    config,
    legs({ 1: { multiplier: multiplierBits(1.1) } }),
    f.now,
  );
  const x = r.legs![1]!;
  expect(x > 99_999_999n * WAD / 1_000_000n && x < 100_000_001n * WAD / 1_000_000n).toBe(true);
  expect(r.spot).toBe(100n * WAD);
  // Ignoring the multiplier would misprice NVDAx by 10% and fail the dispersion check.
  expect(() => reference(f.source, f.prices, G, market, policy, config, legs(), f.now)).toThrow(
    "disagree",
  );
});
test("halted or unpriced legs are excluded; the rest agree on one share price", () => {
  const f = feeds();
  price(f, 1).priceUsd = 300;
  expect(() => reference(f.source, f.prices, G, market, policy, config, legs(), f.now)).toThrow();
  expect(
    reference(f.source, f.prices, G, market, policy, config, legs({ 2: paused }), f.now).legs,
  ).toEqual({ 1: 100n * WAD, 3: 100n * WAD });
  // Even count: the midpoint of the two remaining observations.
  price(f, 2).priceUsd = 101;
  expect(
    reference(f.source, f.prices, G, market, policy, config, legs({ 2: paused }), f.now).spot,
  ).toBe(1005n * WAD / 10n);
  // A stale issuer price removes that leg only.
  const g = feeds();
  price(g, 0).status = "stale";
  expect(reference(g.source, g.prices, G, market, policy, config, legs(), g.now).legs).toEqual({
    2: 100n * WAD,
    3: 100n * WAD,
  });
  // No tradable leg with a price: fail closed.
  expect(() =>
    reference(g.source, g.prices, G, market, policy, config, legs({ 2: paused, 3: paused }), g.now),
  ).toThrow("No tradable");
});
test("only reference issuers price the book: a non-reference outlier is ignored", () => {
  // Mainnet today: NVDAx $228.89 vs NVDAon $218.94 (4.5% apart).
  const f = feeds();
  price(f, 0).priceUsd = 228.89;
  price(f, 1).priceUsd = 218.94;
  price(f, 2).priceUsd = 228.89;
  // Default (every leg references): the outlier pauses the market.
  expect(() => reference(f.source, f.prices, G, market, policy, config, legs(), f.now)).toThrow(
    "disagree",
  );
  // xStocks as the single reference: NVDAon never affects price or pause.
  const xOnly = { ...policy, referenceMints: [policy.baseMints[0]!] },
    g = feeds(Date.now(), xOnly);
  expect(g.prices.prices.map((p) => p.mint)).toEqual([policy.baseMints[0]!, policy.quoteMint]);
  price(g, 0).priceUsd = 228.89;
  const r = reference(g.source, g.prices, G, market, xOnly, config, legs(), g.now);
  expect(r.spot).toBe(22889n * WAD / 100n);
  expect(r.legs).toEqual({ 1: 22889n * WAD / 100n });
  // A halted reference leg cannot be replaced by a non-reference price.
  expect(() =>
    reference(g.source, g.prices, G, market, xOnly, config, legs({ 1: paused }), g.now),
  ).toThrow("No tradable reference");
});
test("dispersion still pauses among several reference issuers", () => {
  const twoRefs = { ...policy, referenceMints: [policy.baseMints[0]!, policy.baseMints[2]!] },
    f = feeds(Date.now(), twoRefs);
  price(f, 1).priceUsd = 104;
  expect(() => reference(f.source, f.prices, G, market, twoRefs, config, legs(), f.now)).toThrow(
    "disagree",
  );
  price(f, 1).priceUsd = 102;
  expect(reference(f.source, f.prices, G, market, twoRefs, config, legs(), f.now).spot).toBe(
    101n * WAD,
  );
  // The spot-price request carries only reference mints.
  expect(f.prices.prices).toHaveLength(3);
});
test("stale, one-sided, crossed, low-depth, extreme or incorrectly oriented probabilities fail closed", () => {
  for (const edit of [
    (f: ReturnType<typeof feeds>) => (f.source.probability.isStale = true),
    (f) => (f.source.probability.quality = "one-sided"),
    (f) => (f.source.probability.bestBidX6 = "420000"),
    (f) => (f.source.probability.bidDepthQuoteX6 = "0"),
    (f) => (f.source.probability.observedAtMs = String(f.now - 60000)),
    (f) => (f.source.probability.yesTokenId = "wrong"),
    (f) => (f.source.metadata.normalized.outcomes[0]!.indexSet = "2"),
    (f) => (f.source.metadata.normalized.closed = true),
    (f) => (f.source.probability.conditionId = "0x" + "00".repeat(32)),
    (f) => (f.source.probability.midpointX6 = "1000000"),
  ] as ((f: ReturnType<typeof feeds>) => unknown)[]) {
    const f = feeds();
    edit(f);
    expect(() =>
      reference(f.source, f.prices, G, market, policy, config, legs(), f.now),
    ).toThrow();
  }
});
test("missing, duplicate, substituted and stale spot quotes cannot price orders", () => {
  for (const edit of [
    (f: ReturnType<typeof feeds>) => (price(f, 3).status = "stale"),
    (f) => (price(f, 3).priceTimestamp -= 120),
    (f) => (price(f, 0).sourceMint = policy.quoteMint),
    (f) => (price(f, 3).priceUsd = NaN),
    (f) => (f.prices.prices[1] = price(f, 0)),
    (f) => (f.prices.genesisHash = "wrong"),
    (f) => f.prices.prices.pop(),
    (f) => {
      for (const i of [0, 1, 2]) price(f, i).priceTimestamp -= 120;
    },
  ] as ((f: ReturnType<typeof feeds>) => unknown)[]) {
    const f = feeds();
    edit(f);
    expect(() =>
      reference(f.source, f.prices, G, market, policy, config, legs(), f.now),
    ).toThrow();
  }
  // A policy listing different legs than the market cannot be priced.
  const f = feeds();
  expect(() =>
    reference(
      f.source,
      f.prices,
      G,
      marketAccount({ baseMints: policy.baseMints.slice(0, 2) }),
      policy,
      config,
      legs(),
      f.now,
    ),
  ).toThrow();
});
test("an explicit Devnet-only policy may use a recently fetched unchanged Jupiter quote", () => {
  const devnetPolicy = {
      ...policy,
      baseMints: [DEVNET_ASSET_MINTS.NVDA],
      quoteMint: DEVNET_ASSET_MINTS.USDC,
      baseInventories: ["1"],
      basePriceMultipliers: ["1"],
    },
    devnetMarket = marketAccount({
      baseMints: devnetPolicy.baseMints,
      quoteMint: devnetPolicy.quoteMint,
      decimals: [6, 9],
      scales: [1000n],
    });
  const f = feeds(Date.now(), devnetPolicy, SOLANA_DEVNET_GENESIS);
  price(f, 0).status = "stale";
  price(f, 0).priceTimestamp -= 300;
  const devnet = settings({
    markets: [devnetPolicy],
    allowStaleDevnetSpot: true,
    maxFeedAgeMs: 600000,
  });
  const read = (s: typeof devnet) =>
    reference(
      f.source,
      f.prices,
      SOLANA_DEVNET_GENESIS,
      devnetMarket,
      devnetPolicy,
      s,
      legs({}, devnetMarket),
      f.now,
    );
  expect(read(devnet).spot).toBe(100n * WAD);
  expect(() => read({ ...devnet, allowStaleDevnetSpot: false })).toThrow();
});
test("reference reads request every issuer leg and the quote in one spot-price call", async () => {
  const f = feeds(),
    urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (request: RequestInfo | URL) => {
      urls.push(String(request));
      return new Response(
        JSON.stringify(String(request).includes("/polymarket") ? f.source : f.prices),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const r = await fetchReference("https://example.com", G, market, policy, config, legs());
    expect(r.spot).toBe(100n * WAD);
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(urls).toContain(
    `https://example.com/v1/spot-prices?mints=${[...policy.baseMints, policy.quoteMint].join(",")}`,
  );
  // Default referenceMints = every leg: unchanged behaviour.
  expect(settings({ markets: [policy] }).markets[0]!.referenceMints).toBeUndefined();
});
test("reference HTTP transport rejects unsafe origins, failure responses and oversized bodies", async () => {
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com/?token=x",
  ])
    expect(() => apiOrigin(url)).toThrow();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (request: RequestInfo | URL) =>
      String(request).endsWith("/large")
        ? new Response("x".repeat(513000))
        : new Response("denied", { status: 429 }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    await expect(json("https://example.com/denied")).rejects.toThrow();
    await expect(json("https://example.com/large")).rejects.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
