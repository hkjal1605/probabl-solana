import { describe, expect, test } from "bun:test";
import { formatProbability, formatUsd, shortAddress } from "@/lib/format/display";

describe("financial display states", () => {
  test("withholds missing reference data instead of implying zero", () => {
    expect(formatProbability(null)).toBe("Withheld");
    expect(formatUsd(null)).toBe("Unavailable");
  });

  test("formats probability and account identity for scanning", () => {
    expect(formatProbability(0.734)).toBe("73%");
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});
