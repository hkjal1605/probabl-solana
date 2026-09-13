import { describe, expect, test } from "bun:test";

import { MarketDataError, noOutcome, normalizeGammaMarket, yesOutcome } from "../src/index.ts";
import { gammaMarket } from "./helpers.ts";

describe("Polymarket metadata normalization", () => {
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
