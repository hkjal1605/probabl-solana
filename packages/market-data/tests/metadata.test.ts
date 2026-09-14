import { describe, expect, test } from "bun:test";

import {
  MarketDataError,
  noOutcome,
  normalizeGammaMarket,
  polymarketImageUrl,
  yesOutcome,
} from "../src/index.ts";
import { gammaMarket } from "./helpers.ts";

describe("Polymarket metadata normalization", () => {
  test("preserves artwork without changing the outcome mapping", () => {
    const image = "https://polymarket-upload.s3.us-east-2.amazonaws.com/event.png";
    const baseline = normalizeGammaMarket(gammaMarket());
    const normalized = normalizeGammaMarket(
      gammaMarket({ image, icon: "https://example.com/icon.png" }),
    );
    expect(normalized.imageUrl).toBe(image);
    expect(normalized.mappingHash).toBe(baseline.mappingHash);
    expect(baseline.imageUrl).toBeNull();
    // Legacy immutable snapshots retain the source payload even without a normalized imageUrl.
    expect(polymarketImageUrl(JSON.parse(JSON.stringify({ image })))).toBe(image);
  });

  test("falls back to icons and ignores unsafe or malformed artwork", () => {
    const icon = "https://example.com/icon.png";
    for (const image of [
      null,
      "",
      42,
      {},
      "/relative.png",
      "javascript:alert(1)",
      "data:image/svg+xml,test",
      "http://example.com/image.png",
      "https://user:secret@example.com/a",
      "x".repeat(2049),
    ]) {
      expect(normalizeGammaMarket(gammaMarket({ image, icon })).imageUrl).toBe(icon);
      expect(polymarketImageUrl({ image })).toBeNull();
    }
    expect(polymarketImageUrl({ imageUrl: icon })).toBe(icon);
    expect(polymarketImageUrl(null)).toBeNull();
  });

  test("binds token IDs to the exact YES and NO index orientation", () => {
    const ordinary = normalizeGammaMarket(gammaMarket());
    expect(yesOutcome(ordinary)).toEqual({ indexSet: "1", label: "YES", tokenId: "111" });
    expect(noOutcome(ordinary)).toEqual({ indexSet: "2", label: "NO", tokenId: "222" });

    const reversed = normalizeGammaMarket(
      gammaMarket({
        clobTokenIds: ["900", "800"],
        outcomes: ["No", "Yes"],
      }),
    );
    expect(yesOutcome(reversed)).toEqual({ indexSet: "2", label: "YES", tokenId: "800" });
    expect(noOutcome(reversed)).toEqual({ indexSet: "1", label: "NO", tokenId: "900" });
  });

  test("rejects non-binary, duplicate-token, and negative-risk markets", () => {
    for (const input of [
      gammaMarket({ outcomes: '["Up","Down"]' }),
      gammaMarket({ clobTokenIds: '["111","111"]' }),
      gammaMarket({ negRisk: true }),
    ]) {
      expect(() => normalizeGammaMarket(input)).toThrow(MarketDataError);
    }
  });
});
