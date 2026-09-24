import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  normalizeSearch,
  SEARCH_LIMIT,
  searchMarkets,
} from "../src/modules/MarketSearchModule/utils/searchMarkets";
import { fixtureMarkets } from "./fixtures/protocol";

test("text inputs use secondary surfaces without blue focus rings; other controls keep focus outlines", async () => {
  const root = new URL("../src/", import.meta.url);
  for (const file of ["input.tsx", "textarea.tsx", "input-group.tsx"]) {
    const source = await readFile(new URL(`components/ui/${file}`, root), "utf8");
    expect(source).toContain("bg-secondary");
    expect(source).not.toMatch(
      /focus-visible\]?:border-ring|focus-visible\]?:ring-3|focus-visible\]?:ring-ring/,
    );
  }
  const css = await readFile(new URL("styles/global.css", root), "utf8");
  expect(css).toContain(":not(input, textarea):focus-visible");
});

test("market search handles case, whitespace, symbols, questions, names and exact addresses", () => {
  const seed = fixtureMarkets[0];
  if (!seed) throw new Error("Missing fixture");
  const btc = {
    ...seed,
    id: "BTC-market",
    ticker: "BTC",
    question: "Will the clarity act pass?",
    bases: [{ ...seed.bases[0]!, mint: "ExactMintAddress", symbol: "BTCx", issuer: "xStocks" }],
  };
  const eth = { ...seed, id: "ETH-market", ticker: "ETH", question: btc.question };
  expect(searchMarkets([btc, eth], "  BTC   clarity  ").items).toEqual([btc]);
  expect(searchMarkets([btc, eth], "EXACTMINTADDRESS").items).toEqual([btc]);
  // Issuer symbols and every listed issuer mint are searchable.
  expect(searchMarkets([btc, eth], "btcx").items).toEqual([btc]);
  expect(searchMarkets([btc, eth], "NVDAon").items).toEqual([eth]);
  expect(searchMarkets([btc, eth], seed.bases[2]!.mint).items).toEqual([eth]);
  expect(searchMarkets([btc, eth], "clarity").total).toBe(2);
  expect(searchMarkets([btc, eth], "eth-market").items).toEqual([eth]);
  expect(searchMarkets([btc, eth], "nothing matches").total).toBe(0);
  expect(searchMarkets([btc, eth], "   ").total).toBe(2);
  expect(normalizeSearch(" ＢＴＣ ")).toBe("btc");
  expect(searchMarkets([btc], "<script>alert(1)</script>").items).toEqual([]);
});

test("search keeps distinct market identities and limits rendering without hiding the total", () => {
  const seed = fixtureMarkets[0];
  if (!seed) throw new Error("Missing fixture");
  const markets = Array.from({ length: SEARCH_LIMIT + 10 }, (_, i) => ({
    ...seed,
    id: `market-${i}`,
  }));
  const before = markets.map((m) => m.id);
  const results = searchMarkets(markets, "");
  expect(results.total).toBe(60);
  expect(results.items).toHaveLength(SEARCH_LIMIT);
  expect(markets.map((m) => m.id)).toEqual(before);
  expect(new Set(results.items.map((m) => m.id)).size).toBe(SEARCH_LIMIT);
  expect(searchMarkets(markets, "market-59").items[0]?.id).toBe("market-59");
});

test("search uses the existing catalogue rather than adding per-query requests or a polling hook", async () => {
  const source = await readFile(
    new URL("../src/hooks/useMarketCatalogue.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain('marketsStore.get("all").data === undefined');
  expect(source).not.toMatch(/setInterval|useMarkets\(|useSpotPrices|fetch\(/);
  const explorer = await readFile(
    new URL("../src/modules/MarketsPageModule/components/MarketsExplorer.tsx", import.meta.url),
    "utf8",
  );
  expect(explorer).not.toMatch(/filters.query|Search markets|<Input/);
  expect(explorer).toContain("window.history.pushState");
  expect(explorer).not.toContain("router.push(");
});
