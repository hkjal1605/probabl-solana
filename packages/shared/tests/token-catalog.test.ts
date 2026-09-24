import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assetDisplayName,
  catalogToken,
  catalogTokenByMint,
  catalogTokensForAsset,
  formatReplicaMints,
  ISSUER_TOKEN_CATALOG,
  parseReplicaMints,
} from "../src/token-catalog";

test("the catalog holds one exact identity per mainnet issuer token", () => {
  expect(ISSUER_TOKEN_CATALOG.map((t) => t.symbol)).toEqual([
    "NVDAx", "NVDAon", "TSLAx", "TSLAon", "SPYx", "SPYon",
    "OPENAI", "tOpenAI", "SPACEX", "tSpaceX", "KALSHI", "tKalshi", "ANTHROPIC",
  ]);
  expect(new Set(ISSUER_TOKEN_CATALOG.map((t) => t.mint)).size).toBe(ISSUER_TOKEN_CATALOG.length);
  for (const token of ISSUER_TOKEN_CATALOG) {
    expect(token.name.length).toBeGreaterThan(0);
    expect(token.description.length).toBeGreaterThan(0);
    expect(token.uri).toMatch(/^https:\/\//);
    expect(token.image).toMatch(/^https:\/\//);
    // Every logo is bundled with the UI (no hotlinking to issuer CDNs).
    expect(existsSync(resolve(import.meta.dir, "../../../apps/ui/public", `.${token.logo}`))).toBe(true);
    expect(token.multiplier).toBeGreaterThan(0);
    expect(catalogToken(token.symbol)).toBe(token);
    expect(catalogTokenByMint(token.mint)).toBe(token);
  }
  // Issuer conventions as published on mainnet.
  expect(catalogToken("NVDAx")).toMatchObject({ name: "NVIDIA xStock", issuer: "xStocks", decimals: 8 });
  expect(catalogToken("SPYon")).toMatchObject({ name: "SPDR S&P 500 ETF (Ondo Tokenized)", kind: "etf" });
  expect(catalogToken("OPENAI")).toMatchObject({ name: "OpenAI PreStocks", kind: "pre-ipo", transferFeeBps: 300 });
  expect(catalogToken("tSpaceX")).toMatchObject({ name: "T-SpaceX", issuer: "Tessera", transferFeeBps: 20 });
  expect(catalogToken("SPACEX")!.multiplier).toBe(5);
  expect(catalogTokensForAsset("KALSHI").map((t) => t.issuer)).toEqual(["PreStocks", "Tessera"]);
  expect(assetDisplayName("SPY")).toBe("SPDR S&P 500 ETF Trust");
  expect(assetDisplayName("UNKNOWN")).toBeUndefined();
  expect(catalogToken("NVDAr")).toBeUndefined();
});

test("replica mint lists round-trip and reject anything ambiguous", () => {
  const a = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    b = "iTUCuHTUHKqWe3XhUc5J3dSjmDdNuQKYtQh8KDYZdDD";
  const parsed = parseReplicaMints(` tOpenAI=${a} , NVDAx=${b}`);
  expect(parsed).toEqual({ tOpenAI: a, NVDAx: b });
  expect(formatReplicaMints(parsed)).toBe(`NVDAx=${b},tOpenAI=${a}`);
  expect(parseReplicaMints(undefined)).toEqual({});
  expect(parseReplicaMints("")).toEqual({});
  for (const bad of [`NVDAr=${a}`, "NVDAx=not-a-mint", `NVDAx=${a}=x`, `=${a}`, `NVDAx=${a},NVDAx=${b}`, `NVDAx=${a},SPYx=${a}`])
    expect(() => parseReplicaMints(bad)).toThrow("issuer replica entry");
});
