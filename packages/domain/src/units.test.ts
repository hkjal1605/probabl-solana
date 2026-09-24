import { describe, expect, test } from "bun:test";
import { quoteForExecution, quoteForReservation } from "./math.ts";
import {
  assertMarketUnits,
  assertShareUnits,
  formatLegAmount,
  formatPriceRawX18,
  formatShareAmount,
  formatTokenAmount,
  legScale,
  type MarketUnits,
  PRICE_FORMAT,
  parseLegAmount,
  parsePriceRawX18,
  parseShareAmount,
  parseTokenAmount,
  priceExponent,
  quantityDecimals,
  SHARE_PRICE_FORMAT,
  SHARE_PROTOCOL_VERSION,
  type ShareUnits,
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

const shares: ShareUnits = {
  shareDecimals: 6,
  quoteTokenDecimals: 6,
  protocolVersion: SHARE_PROTOCOL_VERSION,
  priceFormat: SHARE_PRICE_FORMAT,
};

describe("v3 share-unit ratio", () => {
  test("price exponent is 18 + quote decimals - share decimals", () => {
    expect(priceExponent(shares)).toBe(18);
    expect(priceExponent({ ...shares, shareDecimals: 8 })).toBe(16);
    expect(priceExponent(units)).toBe(6);
  });
  test("one share at 200 USDC settles 200 million raw USDC units", () => {
    const quantity = parseShareAmount("1", shares);
    const price = parsePriceRawX18("200", shares);
    expect(quantity).toBe(1_000_000n);
    expect(price).toBe(200n * 10n ** 18n);
    expect(quoteForExecution(quantity, price)).toBe(200_000_000n);
    expect(formatPriceRawX18(price, shares)).toBe("200");
    expect(formatShareAmount(1_500_000n, shares)).toBe("1.5");
  });
  test("share quantities reject precision beyond share decimals", () => {
    expect(() => parseShareAmount("0.0000001", shares)).toThrow();
    expect(parseShareAmount("0.000001", shares)).toBe(1n);
  });
  test("legacy v2 units still format through the shared helpers", () => {
    expect(quantityDecimals(units)).toBe(18);
    expect(formatShareAmount(10n ** 18n, units)).toBe("1");
  });
  test("v3 assertion rejects v2 metadata and unverified decimals", () => {
    expect(() => assertShareUnits(shares)).not.toThrow();
    for (const bad of [
      undefined,
      units,
      { ...shares, protocolVersion: 2 },
      { ...shares, priceFormat: PRICE_FORMAT },
      { ...shares, shareDecimals: undefined },
      { ...shares, shareDecimals: 1.5 },
    ])
      expect(() => assertShareUnits(bad)).toThrow();
    expect(() => assertMarketUnits(shares)).toThrow();
  });
  test("leg amounts use the leg's own decimals and scale", () => {
    expect(formatLegAmount(123_456_789n, { decimals: 8 })).toBe("1.23456789");
    expect(formatLegAmount(1_000_000_000n, { decimals: 9 })).toBe("1");
    expect(parseLegAmount("0.5", { decimals: 9 })).toBe(500_000_000n);
    expect(legScale(8, 6)).toBe(100n);
    expect(legScale(9, 6)).toBe(1000n);
    expect(legScale(6, 6)).toBe(1n);
    expect(() => legScale(5, 6)).toThrow();
    expect(() => legScale(30, 6)).toThrow();
  });
});
