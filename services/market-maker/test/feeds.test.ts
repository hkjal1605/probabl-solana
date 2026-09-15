import { expect, test } from "bun:test";
import { SOLANA_DEVNET_GENESIS } from "@conditional-stocks/shared/spot-prices";
import { reference, apiOrigin, json } from "../src/feeds";
import { feeds, market, policy, config } from "./fixtures";
test("price normalization honors both quote USD price and explicitly reviewed raw-unit multipliers", () => {
  const f = feeds();
  const r = reference(f.source, f.prices, SOLANA_DEVNET_GENESIS, market, policy, config, f.now);
  expect(r.spot).toBe(10n ** 18n);
  expect(r.probability).toBe(400000n);
  f.prices.prices[1]!.priceUsd = 0.5;
  expect(
    reference(
      f.source,
      f.prices,
      SOLANA_DEVNET_GENESIS,
      market,
      { ...policy, basePriceMultiplier: "2" },
      config,
      f.now,
    ).spot,
  ).toBe(4n * 10n ** 18n);
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
      reference(f.source, f.prices, SOLANA_DEVNET_GENESIS, market, policy, config, f.now),
    ).toThrow();
  }
});
test("missing, duplicate, substituted and stale spot quotes cannot price orders", () => {
  for (const edit of [
    (f: ReturnType<typeof feeds>) => (f.prices.prices[0]!.status = "stale"),
    (f) => (f.prices.prices[0]!.priceTimestamp -= 120),
    (f) => (f.prices.prices[0]!.sourceMint = policy.quoteMint),
    (f) => (f.prices.prices[0]!.priceUsd = NaN),
    (f) => (f.prices.prices[1] = f.prices.prices[0]!),
    (f) => (f.prices.genesisHash = "wrong"),
    (f) => f.prices.prices.pop(),
  ] as ((f: ReturnType<typeof feeds>) => unknown)[]) {
    const f = feeds();
    edit(f);
    expect(() =>
      reference(f.source, f.prices, SOLANA_DEVNET_GENESIS, market, policy, config, f.now),
    ).toThrow();
  }
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
