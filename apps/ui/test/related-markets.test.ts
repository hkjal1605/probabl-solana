import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { relatedMarkets } from "../src/modules/MarketDetailPageModule/utils/relatedMarkets";
import { fixtureMarkets } from "./fixtures/protocol";

const seed = fixtureMarkets[0];
if (!seed) throw new Error("Missing market fixture");
const spy = { ...seed, id: "spy", ticker: "SPY", baseToken: "spy-mint" };
const btc = { ...seed, id: "btc", ticker: "BTC", baseToken: "btc-mint", tradingOpen: "2026-01-01" };
const eth = {
  ...seed,
  id: "eth",
  ticker: "ETH",
  baseToken: "eth-mint",
  lifecycle: "scheduled" as const,
};

test("asset navigation includes all event assets despite differing timing and lifecycle", () => {
  const catalogue = [spy, btc, eth];
  for (const current of catalogue) {
    expect(relatedMarkets(current, catalogue).map((m) => m.id)).toEqual(["btc", "eth", "spy"]);
  }
});

test("related markets exclude unrelated events and incompatible outcome mappings", () => {
  const otherEvent = { ...btc, mapping: { ...btc.mapping, conditionId: "another-condition" } };
  const reversed = { ...eth, mapping: { ...eth.mapping, yesIndex: "different" } };
  expect(relatedMarkets(spy, [otherEvent, reversed]).map((m) => m.id)).toEqual(["spy"]);
  expect(
    relatedMarkets({ ...spy, mapping: { ...spy.mapping, conditionId: "" } }, [btc]),
  ).toHaveLength(1);
});

test("current asset remains available during catalogue loading; IDs are deduplicated, not symbols", () => {
  expect(relatedMarkets(spy, [])).toEqual([spy]);
  expect(relatedMarkets(spy, [spy, spy])).toHaveLength(1);
  const anotherQuote = { ...spy, id: "spy-other-quote", quoteToken: "another-mint" };
  expect(relatedMarkets(spy, [spy, anotherQuote])).toHaveLength(2);
});

test("retried markets cannot duplicate one base and quote asset tab", () => {
  const retry = { ...spy, id: "spy-retry", lifecycle: "frozen" as const };
  expect(relatedMarkets(spy, [retry]).map((market) => market.id)).toEqual(["spy"]);
  expect(relatedMarkets(retry, [spy]).map((market) => market.id)).toEqual(["spy-retry"]);
});

test("asset switches navigate by market ID and remount the trading workspace", async () => {
  const base = new URL("../src/modules/MarketDetailPageModule/", import.meta.url);
  const switcher = await readFile(new URL("components/MarketAssetSwitcher.tsx", base), "utf8");
  const module = await readFile(new URL("index.tsx", base), "utf8");
  expect(switcher).toContain("useMarketCatalogue()");
  expect(switcher).toMatch(/href=\{`\/markets\/\$\{asset\.id\}`\}/);
  expect(switcher).toContain("aria-current");
  expect(module).toContain("key={marketId}");
});
