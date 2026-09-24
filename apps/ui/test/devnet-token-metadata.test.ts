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
  ISSUER_TOKEN_METADATA,
  issuerFromSymbol,
  marketTokenDisplay,
  SOLANA_DEVNET_GENESIS,
  tokenMetadata,
} from "../src/lib/tokens/devnet";
import { fixtureMarkets } from "./fixtures/protocol";

// Public addresses from the completed Devnet deployment; no private fixture/env imports.
const deployed = [
  ["827noEu9yuV2HXiqFJhESUREcfkvA8RKXMxNKdVqxuvb", "USDC", "USD Coin", undefined],
  ["9Lq6s3X22MTefov2hi9VtTRUbMaCahNpaQXmxtcu6H1S", "BTC", "Bitcoin", undefined],
  ["AxkdvS81zeZB62C6uWSUm2K5BUKeKvhR6upt1FnU6Hmi", "ETH", "Ethereum", undefined],
  ["So11111111111111111111111111111111111111112", "SOL", "Wrapped SOL", undefined],
  ["DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC", "TSLA", "Tesla", "TSLA"],
  ["8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u", "NVDA", "NVIDIA", "NVDA"],
  ["8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3", "SPY", "SPDR S&P 500 ETF Trust", "SPY"],
] as const;
const quote = deployed[0][0];

test("every deployed test mint has its own immutable name, symbol and bundled image", async () => {
  expect(Object.keys(DEVNET_TOKEN_METADATA).sort()).toEqual(deployed.map(([mint]) => mint).sort());
  expect(Object.isFrozen(DEVNET_TOKEN_METADATA)).toBe(true);
  for (const [mint, symbol, name, asset] of deployed) {
    expect(new PublicKey(mint).toBase58()).toBe(mint);
    const metadata = devnetTokenMetadata(mint, SOLANA_DEVNET_GENESIS);
    expect(metadata).toEqual({
      name,
      symbol,
      image: `/tokens/devnet/${symbol.toLowerCase()}.svg`,
      devnet: true,
      ...(asset ? { asset } : {}),
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
      expect(marketTokenDisplay([mint], quote, genesis, "EXISTING")).toEqual({
        ticker: "EXISTING",
        assetKey: `mints:${mint}`,
        legs: [{ symbol: "EXISTING", issuer: null }],
      });
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
    expect(marketTokenDisplay([mint], mint, SOLANA_DEVNET_GENESIS, "STOCK")).toEqual({
      ticker: "STOCK",
      assetKey: `mints:${mint}`,
      legs: [{ symbol: "STOCK", issuer: null }],
    });
  }
});

test("base-mint identity overrides unrelated Polymarket asset hints; quote metadata is independent", () => {
  const display = marketTokenDisplay([deployed[1][0]], quote, SOLANA_DEVNET_GENESIS, "NVDA");
  expect(display.ticker).toBe("BTC");
  expect(display.assetMetadata?.name).toBe("Bitcoin");
  expect(display.quoteTokenMetadata?.symbol).toBe("USDC");
  const fallback = marketTokenDisplay(["unknown"], quote, SOLANA_DEVNET_GENESIS, "ORIGINAL");
  expect(fallback.ticker).toBe("ORIGINAL");
  expect(fallback.assetMetadata).toBeUndefined();
  expect(fallback.quoteTokenMetadata).toEqual(DEVNET_TOKEN_METADATA[quote]);
});

test("three assets retain their shared event and exact trading fields, with distinct names and images", () => {
  const fixture = fixtureMarkets[0];
  if (!fixture) throw new Error("Missing market fixture");
  const markets = [deployed[6], deployed[1], deployed[2]].map(([mint], i) => {
    const source = {
      ...fixture,
      id: `market-${i}`,
      bases: [{ ...fixture.bases[0]!, mint }],
      quoteToken: quote,
      ticker: "STOCK",
    };
    const { legs: _legs, ...display } = marketTokenDisplay(
      [mint],
      quote,
      SOLANA_DEVNET_GENESIS,
      source.ticker,
    );
    const {
      ticker: _ticker,
      assetKey: _key,
      assetMetadata: _asset,
      quoteTokenMetadata: _quote,
      ...unchanged
    } = { ...source, ...display };
    const { ticker: _originalTicker, assetKey: _originalKey, ...original } = source;
    expect(unchanged).toEqual(original);
    return { ...source, ...display };
  });
  expect(groupMarkets(markets)).toHaveLength(1);
  expect(markets.map((m) => m.ticker)).toEqual(["SPY", "BTC", "ETH"]);
  expect(new Set(markets.map((m) => m.id)).size).toBe(3);
  const html = markets
    .map((m) =>
      renderToStaticMarkup(
        createElement(TokenIdentity, {
          symbol: m.ticker,
          metadata: m.assetMetadata,
        }),
      ),
    )
    .join("");
  for (const symbol of ["SPY", "BTC", "ETH"]) {
    expect(markets.find((m) => m.ticker === symbol)?.assetMetadata?.image).toBe(
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

const NVDAx = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const NVDAon = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";
const NVDAr = "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu";

test("issuer tokens of one stock display their own symbols and issuers under one asset", () => {
  for (const mint of [NVDAx, NVDAon, NVDAr]) {
    expect(new PublicKey(mint).toBase58()).toBe(mint);
    expect(Object.isFrozen(ISSUER_TOKEN_METADATA[mint])).toBe(true);
    // Issuer mints are exact addresses; they resolve on any cluster.
    expect(tokenMetadata(mint, "")?.asset).toBe("NVDA");
  }
  const display = marketTokenDisplay([NVDAx, NVDAon, NVDAr], quote, SOLANA_DEVNET_GENESIS, "X");
  expect(display.ticker).toBe("NVDA");
  expect(display.assetKey).toBe("asset:NVDA");
  expect(display.assetMetadata).toMatchObject({ symbol: "NVDA", name: "NVIDIA", devnet: false });
  expect(display.legs.map((leg) => [leg.symbol, leg.issuer])).toEqual([
    ["NVDAx", "xStocks"],
    ["NVDAon", "Ondo Global Markets"],
    ["NVDAr", "Remora"],
  ]);
  // A different subset of the same stock's issuers is still the same asset.
  expect(marketTokenDisplay([NVDAon], quote, "", "X").assetKey).toBe("asset:NVDA");
  // A devnet asset mixed with its issuer tokens keeps the devnet asset icon.
  const mixed = marketTokenDisplay([deployed[5][0], NVDAx], quote, SOLANA_DEVNET_GENESIS, "X");
  expect(mixed.assetKey).toBe("asset:NVDA");
  expect(mixed.assetMetadata?.devnet).toBe(true);
  expect(issuerFromSymbol("NVDAx")).toBe("xStocks");
  expect(issuerFromSymbol("NVDAon")).toBe("Ondo Global Markets");
  expect(issuerFromSymbol("NVDAr")).toBe("Remora");
  expect(issuerFromSymbol("NVDA")).toBeNull();
  const tooltip = renderToStaticMarkup(
    createElement(TokenIdentity, { symbol: "NVDAon", metadata: tokenMetadata(NVDAon, "") }),
  );
  expect(tooltip).toContain("Ondo Global Markets");
  expect(tooltip).not.toContain("Devnet test asset");
});

test("unknown legs get distinct synthetic labels and group by their exact mint set", () => {
  const a = marketTokenDisplay(["m2", "m1"], quote, "", "NVDA");
  const b = marketTokenDisplay(["m1", "m2"], quote, "", "NVDA");
  expect(a.legs.map((leg) => leg.symbol)).toEqual(["NVDA·1", "NVDA·2"]);
  expect(a.assetKey).toBe(b.assetKey);
  expect(a.assetKey).not.toBe(marketTokenDisplay(["m3"], quote, "", "NVDA").assetKey);
});

test("mainnet issuer tokens and their devnet replicas show the issuer's exact identity and logo", async () => {
  const { ISSUER_TOKEN_CATALOG } = await import("@conditional-stocks/shared/token-catalog");
  const { replicaTokenMetadata } = await import("../src/lib/tokens/devnet");
  for (const token of ISSUER_TOKEN_CATALOG) {
    const metadata = tokenMetadata(token.mint, "");
    expect(metadata).toMatchObject({
      symbol: token.symbol,
      name: token.name,
      issuer: token.issuer,
      asset: token.asset,
      image: token.logo,
      devnet: false,
    });
    // Bundled copies of the issuers' own logos, never hotlinked.
    expect(token.logo).toMatch(/^\/tokens\/issuers\/[a-z]+\.(png|svg)$/);
    const bytes = await readFile(new URL(`../public${token.logo}`, import.meta.url));
    expect(bytes.length).toBeGreaterThan(0);
    if (token.logo.endsWith(".svg")) expect(bytes.toString("utf8")).not.toMatch(/<script|\bonload=/i);
  }
  // Devnet replicas (as exported by the deployment scripts) display exactly as mainnet.
  const replicaOpenAi = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    replicaTOpenAi = "iTUCuHTUHKqWe3XhUc5J3dSjmDdNuQKYtQh8KDYZdDE";
  const replicas = replicaTokenMetadata(`OPENAI=${replicaOpenAi},tOpenAI=${replicaTOpenAi}`);
  expect(tokenMetadata(replicaOpenAi, SOLANA_DEVNET_GENESIS, replicas)).toEqual(
    tokenMetadata("PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF", ""),
  );
  const market = marketTokenDisplay([replicaOpenAi, replicaTOpenAi], quote, SOLANA_DEVNET_GENESIS, "X", replicas);
  expect(market.ticker).toBe("OPENAI");
  expect(market.assetMetadata).toMatchObject({ name: "OpenAI", image: "/tokens/issuers/openai.png" });
  expect(market.legs.map((leg) => [leg.symbol, leg.issuer, leg.metadata?.name])).toEqual([
    ["OPENAI", "PreStocks", "OpenAI PreStocks"],
    ["tOpenAI", "Tessera", "T-OpenAI"],
  ]);
  // Without that deployment configuration (or with a malformed one) nothing is guessed.
  expect(tokenMetadata(replicaOpenAi, SOLANA_DEVNET_GENESIS)).toBeUndefined();
  expect(replicaTokenMetadata("OPENAI=bad")).toEqual({});
  expect(replicaTokenMetadata(`NVDAr=${replicaOpenAi}`)).toEqual({});
  // Stock markets keep the stock icon; issuers come from the catalog or conventions.
  expect(marketTokenDisplay(["Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"], quote, "", "X").assetMetadata?.image).toBe(
    "/tokens/devnet/nvda.svg",
  );
  expect(issuerFromSymbol("OPENAI")).toBe("PreStocks");
  expect(issuerFromSymbol("tKalshi")).toBe("Tessera");
  expect(issuerFromSymbol("tUnknownCo")).toBe("Tessera");
  const tooltip = renderToStaticMarkup(
    createElement(TokenIdentity, { symbol: "tSpaceX", metadata: tokenMetadata("TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v", "") }),
  );
  expect(tooltip).toContain("T-SpaceX (tSpaceX) · Tessera");
});
