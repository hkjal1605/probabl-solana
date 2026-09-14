import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenIdentity } from "../src/components/market/TokenIdentity";
import { groupMarkets } from "../src/lib/markets/presentation";
import {
  DEVNET_TOKEN_METADATA,
  devnetTokenMetadata,
  marketTokenDisplay,
  SOLANA_DEVNET_GENESIS,
} from "../src/lib/tokens/devnet";
import { fixtureMarkets } from "./fixtures/protocol";

// Public addresses from the completed Devnet deployment; no private fixture/env imports.
const deployed = [
  ["iTUCuHTUHKqWe3XhUc5J3dSjmDdNuQKYtQh8KDYZdDD", "USDC", "USD Coin"],
  ["DhC4rpPyVJRHJmNqhMXchqET2o87b6JV6ebfkqA5Ufv4", "BTC", "Bitcoin"],
  ["H2RuZ1p2KBtKesz6kcnLvXhtVK74LAbTrWbH5phyeMkY", "ETH", "Ethereum"],
  ["So11111111111111111111111111111111111111112", "SOL", "Wrapped SOL"],
  ["DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC", "TSLA", "Tesla"],
  ["8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u", "NVDA", "NVIDIA"],
  ["8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3", "SPY", "SPDR S&P 500 ETF Trust"],
] as const;
const quote = deployed[0][0];

test("every deployed test mint has its own immutable name, symbol and bundled image", async () => {
  expect(Object.keys(DEVNET_TOKEN_METADATA).sort()).toEqual(deployed.map(([mint]) => mint).sort());
  expect(Object.isFrozen(DEVNET_TOKEN_METADATA)).toBe(true);
  for (const [mint, symbol, name] of deployed) {
    expect(new PublicKey(mint).toBase58()).toBe(mint);
    const metadata = devnetTokenMetadata(mint, SOLANA_DEVNET_GENESIS);
    expect(metadata).toEqual({
      name,
      symbol,
      image: `/tokens/devnet/${symbol.toLowerCase()}.svg`,
      devnet: true,
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    const svg = await readFile(
      new URL(`../public/tokens/devnet/${symbol.toLowerCase()}.svg`, import.meta.url),
      "utf8",
    );
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).not.toMatch(/<script|<foreignObject|\bonload=|\bhref=/i);
  }
});

test("the map never applies outside Devnet, even for the shared wrapped-SOL mint", () => {
  for (const genesis of [
    "",
    "localnet",
    "devnet",
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    ` ${SOLANA_DEVNET_GENESIS}`,
  ]) {
    for (const [mint] of deployed) {
      expect(devnetTokenMetadata(mint, genesis)).toBeUndefined();
      expect(marketTokenDisplay(mint, quote, genesis, "EXISTING")).toEqual({ ticker: "EXISTING" });
    }
  }
});

test("unknown, differently cased, malformed and object-prototype keys keep the existing fallback", () => {
  for (const mint of [
    "",
    "BTC",
    "__proto__",
    "constructor",
    "toString",
    "11111111111111111111111111111111",
    deployed[1][0].toLowerCase(),
    ` ${deployed[1][0]}`,
  ]) {
    expect(devnetTokenMetadata(mint, SOLANA_DEVNET_GENESIS)).toBeUndefined();
    expect(marketTokenDisplay(mint, mint, SOLANA_DEVNET_GENESIS, "STOCK")).toEqual({
      ticker: "STOCK",
    });
  }
});

test("base-mint identity overrides unrelated Polymarket asset hints; quote metadata is independent", () => {
  const display = marketTokenDisplay(deployed[1][0], quote, SOLANA_DEVNET_GENESIS, "NVDA");
  expect(display.ticker).toBe("BTC");
  expect(display.baseTokenMetadata?.name).toBe("Bitcoin");
  expect(display.quoteTokenMetadata?.symbol).toBe("USDC");
  const fallback = marketTokenDisplay("unknown", quote, SOLANA_DEVNET_GENESIS, "ORIGINAL");
  expect(fallback.ticker).toBe("ORIGINAL");
  expect(fallback.baseTokenMetadata).toBeUndefined();
  expect(fallback.quoteTokenMetadata).toEqual(DEVNET_TOKEN_METADATA[quote]);
});

test("three assets retain their shared event and exact trading fields, with distinct names and images", () => {
  const fixture = fixtureMarkets[0];
  if (!fixture) throw new Error("Missing market fixture");
  const markets = [deployed[6], deployed[1], deployed[2]].map(([mint], i) => {
    const source = {
      ...fixture,
      id: `market-${i}`,
      baseToken: mint,
      quoteToken: quote,
      ticker: "STOCK",
    };
    const {
      ticker: _ticker,
      baseTokenMetadata: _base,
      quoteTokenMetadata: _quote,
      ...unchanged
    } = {
      ...source,
      ...marketTokenDisplay(mint, quote, SOLANA_DEVNET_GENESIS, source.ticker),
    };
    const { ticker: _originalTicker, ...original } = source;
    expect(unchanged).toEqual(original);
    return { ...source, ...marketTokenDisplay(mint, quote, SOLANA_DEVNET_GENESIS, source.ticker) };
  });
  expect(groupMarkets(markets)).toHaveLength(1);
  expect(markets.map((m) => m.ticker)).toEqual(["SPY", "BTC", "ETH"]);
  expect(new Set(markets.map((m) => m.id)).size).toBe(3);
  const html = markets
    .map((m) =>
      renderToStaticMarkup(
        createElement(TokenIdentity, {
          symbol: m.ticker,
          metadata: m.baseTokenMetadata,
        }),
      ),
    )
    .join("");
  for (const symbol of ["SPY", "BTC", "ETH"]) {
    expect(markets.find((m) => m.ticker === symbol)?.baseTokenMetadata?.image).toBe(
      `/tokens/devnet/${symbol.toLowerCase()}.svg`,
    );
    expect(html).toContain(`>${symbol}</strong>`);
  }
  for (const name of ["SPDR S&amp;P 500 ETF Trust", "Bitcoin", "Ethereum"])
    expect(html).toContain(name);
  expect(html).not.toContain("STOCK");
  expect(html).toContain("Devnet test asset");
});

test("unmapped token rendering remains usable without an image; compact mode retains accessible identity", () => {
  const fallback = renderToStaticMarkup(createElement(TokenIdentity, { symbol: "UNKNOWN" }));
  expect(fallback).toContain("UNKNOWN");
  expect(fallback).not.toContain("<img");
  expect(fallback).not.toContain("Devnet");
  const compact = renderToStaticMarkup(
    createElement(TokenIdentity, {
      symbol: "BTC",
      metadata: devnetTokenMetadata(deployed[1][0], SOLANA_DEVNET_GENESIS),
      showName: false,
    }),
  );
  expect(compact).toContain('aria-description="Bitcoin (BTC) · Devnet test asset"');
  // Base Avatar shows its fallback until the image has loaded in the browser.
  expect(compact).toContain('data-slot="avatar-fallback"');
  expect(compact).toContain(">BT</span>");
  expect(compact).not.toContain(">Bitcoin</span>");
});
