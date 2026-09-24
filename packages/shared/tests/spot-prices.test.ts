import { expect, test } from "bun:test";
import {
  issuerToken,
  issuerTokensForAsset,
  MAINNET_ISSUER_TOKENS,
  MAINNET_REFERENCE_MINTS,
  DEVNET_ASSET_MINTS,
  DEVNET_ISSUER_MOCK_SOURCES,
  configureDevnetIssuerReplicas,
  devnetIssuerAliases,
  SOLANA_DEVNET_GENESIS,
  SOLANA_MAINNET_GENESIS,
  SPOT_MAX_AGE_SECONDS,
  type SpotPrice,
  isSolanaMint,
  sharePriceUsd,
  spotMapping,
} from "../src/spot-prices";

const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const NVDAON = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";
const NVDAR = "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu";

test("one economic asset maps to every whitelisted issuer token", () => {
  for (const token of MAINNET_ISSUER_TOKENS) expect(isSolanaMint(token.mint)).toBe(true);
  expect(issuerTokensForAsset("NVDA").map((t) => [t.symbol, t.issuer, t.decimals])).toEqual([
    ["NVDAx", "xStocks", 8],
    ["NVDAon", "Ondo Global Markets", 9],
    ["NVDAr", "Remora", 9],
  ]);
  expect(issuerTokensForAsset("TSLA").map((t) => t.symbol)).toEqual(["TSLAx", "TSLAon"]);
  expect(issuerTokensForAsset("TSLA")[0]!.mint).toBe(MAINNET_REFERENCE_MINTS.TSLA);
  expect(issuerTokensForAsset("SPY").map((t) => t.symbol)).toEqual(["SPYx", "SPYon"]);
  // Pre-IPO companies: PreStocks (scaled) and Tessera (unscaled) tokens of one asset.
  expect(issuerTokensForAsset("OPENAI").map((t) => [t.symbol, t.issuer, t.decimals, t.scaledUiAmount])).toEqual([
    ["OPENAI", "PreStocks", 9, true],
    ["tOpenAI", "Tessera", 9, false],
  ]);
  expect(issuerTokensForAsset("ANTHROPIC").map((t) => t.symbol)).toEqual(["ANTHROPIC"]);
  expect(issuerToken(MAINNET_REFERENCE_MINTS.NVDA)?.mint).toBe(NVDAX);
  expect(issuerToken(MAINNET_REFERENCE_MINTS.USDC)).toBeUndefined();
});

test("mainnet issuer mints are self-sourced aliases with issuer identity; devnet stays explicit", () => {
  for (const [mint, symbol, issuer] of [
    [NVDAX, "NVDAx", "xStocks"],
    [NVDAON, "NVDAon", "Ondo Global Markets"],
    [NVDAR, "NVDAr", "Remora"],
  ]) {
    const mapping = spotMapping(SOLANA_MAINNET_GENESIS, mint!);
    expect(mapping).toMatchObject({
      sourceMint: mint,
      referenceSymbol: symbol,
      asset: "NVDA",
      issuer,
      scaledUiAmount: true,
      // Raw balances of scaled tokens need the live multiplier: use sharePriceUsd.
      valuationCompatible: false,
    });
  }
  expect(spotMapping(SOLANA_DEVNET_GENESIS, DEVNET_ASSET_MINTS.NVDA)).toMatchObject({
    sourceMint: NVDAX,
    referenceSymbol: "NVDAx",
    asset: "NVDA",
  });
  // Unknown devnet mints never inherit an issuer price.
  expect(spotMapping(SOLANA_DEVNET_GENESIS, NVDAON)).toMatchObject({
    sourceMint: null,
    asset: null,
    scaledUiAmount: false,
  });
  expect(spotMapping(SOLANA_MAINNET_GENESIS, MAINNET_REFERENCE_MINTS.USDC)).toMatchObject({
    asset: null,
    issuer: null,
    scaledUiAmount: false,
    valuationCompatible: true,
  });
});

test("per-share price divides the unscaled token price by the live multiplier", () => {
  expect(sharePriceUsd(180.306, 1.0017)).toBeCloseTo(180, 10);
  expect(sharePriceUsd(100, 1)).toBe(100);
  for (const [price, multiplier] of [
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
    [100, 0],
    [100, -1],
    [100, Number.POSITIVE_INFINITY],
    [null, 1],
  ] as const)
    expect(sharePriceUsd(price, multiplier)).toBeNull();
  const now = 1_800_000_000_000;
  const row: SpotPrice = {
    ...spotMapping(SOLANA_MAINNET_GENESIS, NVDAON),
    status: "available",
    priceUsd: 201,
    sourceDecimals: 9,
    blockId: 1,
    priceTimestamp: now / 1000,
    fetchedAt: now / 1000,
  };
  expect(sharePriceUsd(row, 1.005, now)).toBeCloseTo(200, 10);
  // Stale, unavailable or unverified observations never produce a share price.
  expect(sharePriceUsd(row, 1, now + (SPOT_MAX_AGE_SECONDS + 1) * 1000)).toBeNull();
  expect(sharePriceUsd({ ...row, status: "unavailable" }, 1, now)).toBeNull();
  expect(sharePriceUsd({ ...row, priceTimestamp: null }, 1, now)).toBeNull();
});

test("devnet issuer replicas alias exactly the mainnet token they replicate", () => {
  for (const [symbol, source] of Object.entries(DEVNET_ISSUER_MOCK_SOURCES))
    expect(issuerToken(source)?.symbol).toBe(symbol);
  expect(Object.keys(DEVNET_ISSUER_MOCK_SOURCES)).toHaveLength(13);
  // Registered replica mints price as their mainnet source; others stay unmapped.
  const replica = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDW";
  expect(spotMapping(SOLANA_DEVNET_GENESIS, replica).sourceMint).toBeNull();
  configureDevnetIssuerReplicas({ tOpenAI: replica });
  expect(spotMapping(SOLANA_DEVNET_GENESIS, replica)).toMatchObject({
    sourceMint: "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ",
    referenceSymbol: "tOpenAI",
    asset: "OPENAI",
    issuer: "Tessera",
    scaledUiAmount: false,
    valuationCompatible: false,
  });
  // Mainnet never uses devnet aliases.
  expect(spotMapping(SOLANA_MAINNET_GENESIS, replica).sourceMint).toBe(replica);
  configureDevnetIssuerReplicas({});
  expect(spotMapping(SOLANA_DEVNET_GENESIS, replica).sourceMint).toBeNull();
  const mock = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDV";
  expect(devnetIssuerAliases({ NVDAon: mock }).get(mock)).toBe(
    "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
  );
  expect(devnetIssuerAliases({}).size).toBe(0);
});
