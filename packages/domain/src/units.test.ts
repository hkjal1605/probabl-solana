import { describe, expect, test } from "bun:test";
import { quoteForExecution, quoteForReservation } from "./math.ts";
import {
  assertMarketUnits,
  formatPriceRawX18,
  formatTokenAmount,
  type MarketUnits,
  PRICE_FORMAT,
  parsePriceRawX18,
  parseTokenAmount,
} from "./units.ts";

const units: MarketUnits = {
  baseTokenDecimals: 18,
  quoteTokenDecimals: 6,
  protocolVersion: 2,
  priceFormat: PRICE_FORMAT,
};

describe("v2 raw-unit ratio boundaries", () => {
  test("one stock at 200 USDG settles exactly 200 million raw USDG units", () => {
    const quantity = parseTokenAmount("1", 18);
    const price = parsePriceRawX18("200", units);
    expect(price).toBe(200_000_000n);
    expect(quoteForExecution(quantity, price)).toBe(200_000_000n);
    expect(formatPriceRawX18(price, units)).toBe("200");
    expect(formatTokenAmount(quoteForReservation(quantity, price), 6)).toBe("200");
  });
  test("partial fills floor execution, ceil reservation, preserve exact display", () => {
    const q = parseTokenAmount("0.123456789012345678", 18);
    const p = parsePriceRawX18("199.123456", units);
    expect(quoteForExecution(q, p)).toBe((q * p) / 10n ** 18n);
    expect(quoteForReservation(q, p) - quoteForExecution(q, p)).toBe(1n);
    expect(formatTokenAmount(q, 18)).toBe("0.123456789012345678");
    expect(formatPriceRawX18(p, units)).toBe("199.123456");
  });
  test("rejects inexact prices, amount precision, malformed data and overflow", () => {
    for (const input of [
      "0.0000001",
      "200.1234567",
      "1e2",
      "-1",
      "NaN",
      "Infinity",
      " 2",
      "01",
      "0",
      "9".repeat(80),
    ]) {
      expect(() => parsePriceRawX18(input, units)).toThrow();
    }
    expect(() => parseTokenAmount("0.0000001", 6)).toThrow();
    expect(parseTokenAmount("1.0000000", 6)).toBe(1_000_000n);
    expect(parsePriceRawX18("200.0000000", units)).toBe(200_000_000n);
    for (const bad of [
      undefined,
      {},
      { ...units, protocolVersion: 1 },
      { ...units, quoteTokenDecimals: undefined },
      { ...units, quoteTokenDecimals: 255 },
    ]) {
      expect(() => assertMarketUnits(bad)).toThrow();
    }
  });
  test("round trips across decimal combinations, including negative price exponents", () => {
    for (const baseTokenDecimals of [0, 6, 18, 24, 36]) {
      for (const quoteTokenDecimals of [0, 6, 18, 24, 36]) {
        const pair = { ...units, baseTokenDecimals, quoteTokenDecimals };
        for (const raw of [1n, 999999999999999999n, (1n << 128n) - 1n]) {
          expect(parsePriceRawX18(formatPriceRawX18(raw, pair), pair)).toBe(raw);
        }
      }
    }
    expect(() => parsePriceRawX18("1", { ...units, baseTokenDecimals: 36 })).toThrow();
  });
});
