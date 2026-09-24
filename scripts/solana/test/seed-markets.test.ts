import { expect, test } from "bun:test";
import { MARKET_TICKERS } from "../devnet-policy.ts";
import { DEVNET_MARKET_SEED, type SeedMarket, validateMarketSeed } from "../seed-markets-policy.ts";

test("Devnet catalogue: three assets per real-world event, every asset in at least two events", () => {
  expect(validateMarketSeed()).toBe(DEVNET_MARKET_SEED);
  for (const ticker of MARKET_TICKERS)
    expect(DEVNET_MARKET_SEED.filter((market) => market.tickers.includes(ticker)).length).toBeGreaterThanOrEqual(2);
  expect(
    DEVNET_MARKET_SEED.every(
      (market) =>
        !/\b(?:btc|eth|sol|nvda|tsla|spy)\b.*\b(?:reach|hit|above|below)\b/i.test(market.question),
    ),
  ).toBe(true);
});

test("events with other than three distinct assets, or assets tied to one event, are rejected", () => {
  const [first, ...rest] = DEVNET_MARKET_SEED as SeedMarket[];
  expect(() => validateMarketSeed([{ ...first!, tickers: ["TSLA", "TSLA", "SPY"] }, ...rest])).toThrow("three distinct");
  expect(() => validateMarketSeed(rest)).toThrow("fewer than two events");
});
