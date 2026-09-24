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

test("events with other than three distinct assets, assets tied to one event, or thin tabs are rejected", () => {
  const [first, ...rest] = DEVNET_MARKET_SEED as SeedMarket[];
  expect(() => validateMarketSeed([{ ...first!, tickers: ["TSLA", "TSLA", "SPY"] }, ...rest])).toThrow("three distinct");
  const without = (...slugs: string[]) => DEVNET_MARKET_SEED.filter((market) => !slugs.includes(market.slug));
  expect(() =>
    validateMarketSeed(without("major-cex-insolvent-in-2026", "law-banning-sports-prediction-markets-enacted-in-2026")),
  ).toThrow("is tied to fewer than two events");
  expect(() => validateMarketSeed(without("mu-quarterly-earnings-nongaap-eps-09-30-2026-32pt22"))).toThrow(
    "Missing Earnings events",
  );
  // Every UI category tab carries at least three events of three markets.
  for (const category of ["Macro", "Earnings", "Policy", "Other"])
    expect(DEVNET_MARKET_SEED.filter((market) => market.category === category).length).toBeGreaterThanOrEqual(3);
});
