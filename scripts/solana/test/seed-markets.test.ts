import { expect, test } from "bun:test";
import { DEVNET_MARKET_SEED, validateMarketSeed } from "../seed-markets-policy.ts";

test("Devnet catalogue has three unique real-world conditions in every UI category", () => {
  expect(validateMarketSeed()).toBe(DEVNET_MARKET_SEED);
  expect(DEVNET_MARKET_SEED).toHaveLength(12);
  expect(new Set(DEVNET_MARKET_SEED.map((market) => market.category))).toEqual(
    new Set(["Macro", "Earnings", "Policy", "Other"]),
  );
  expect(
    DEVNET_MARKET_SEED.every(
      (market) =>
        !/\b(?:btc|eth|sol|nvda|tsla|spy)\b.*\b(?:reach|hit|above|below)\b/i.test(market.question),
    ),
  ).toBe(true);
});
