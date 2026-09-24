import { describe, expect, test } from "bun:test";
import { createOrder, previewOrder } from "@/lib/trading/order";

const form = {
  shareDecimals: 6,
  quoteTokenDecimals: 6,
  protocolVersion: 3,
  priceFormat: "share-unit-ratio-x18" as const,
  bases: 2,
  account: "4o2JYy6ktdZEfaUVHGwdCbvMyypZ1NRCDpyS1rfY9q8z",
  branch: "NO" as const,
  cutoff: "2027-01-01T00:00:00.000Z",
  funding: "claim" as const,
  marketId: "A8J3WFJC4DsGG5vGUsAB6GmvAwfS6vRqoacaWCGAS8tk",
  price: "123.456",
  quantity: "2.5",
  side: "sell" as const,
  tif: "ioc" as const,
};

describe("order form math", () => {
  test("fee cap defaults to zero and explicit consent is kept in raw bps", () => {
    expect(createOrder(form).maxFeeBps).toBe(0);
    expect(createOrder({ ...form, maxFeeBps: 25 }).maxFeeBps).toBe(25);
    for (const value of [-1, 1.5, 1001, Number.NaN, Infinity]) {
      expect(() => createOrder({ ...form, maxFeeBps: value })).toThrow("Maximum fee");
    }
  });
  test("uses exact share-unit ratio math for 6-decimal shares and 6-decimal USDC", () => {
    expect(previewOrder("2.5", "123.456", form)).toEqual({
      cost: 308.64,
      costRaw: "308640000",
      priceRawX18: "123456000000000000000",
      qty: 2.5,
      quantityRaw: "2500000",
      valid: true,
    });
  });
  test("share quantities are independent of each issuer's token decimals", () => {
    // 8-decimal xStocks and 9-decimal Ondo legs trade the same share unit.
    for (const shareDecimals of [6, 8]) {
      const preview = previewOrder("1.5", "200", { ...form, shareDecimals });
      expect(preview.quantityRaw).toBe(String(15n * 10n ** BigInt(shareDecimals - 1)));
      expect(preview.costRaw).toBe("300000000");
    }
    expect(previewOrder("1.5", "200", { ...form, protocolVersion: 2 }).valid).toBe(false);
  });
  test("buys carry an accepted-issuer mask; sells deliver exactly one issuer", () => {
    const buy = { ...form, side: "buy" as const, funding: "whole" as const };
    expect(createOrder({ ...buy, bases: 7 }).bases).toBe(7);
    expect(createOrder({ ...buy, bases: 5 }).bases).toBe(5);
    expect(createOrder({ ...form, bases: 4 }).bases).toBe(4);
    for (const bases of [0, 8, -1, 1.5]) expect(() => createOrder({ ...buy, bases })).toThrow();
    for (const bases of [3, 7, 0])
      expect(() => createOrder({ ...form, bases })).toThrow("exactly one");
  });

  test("builds the exact immutable wire order reviewed by the signer", () => {
    const order = createOrder(form, {
      nowMs: 1_700_000_000_000,
      salt: `0x${"22".repeat(32)}`,
    });
    expect(order).toMatchObject({
      branch: 1,
      fundingKind: 1,
      limitPriceRawX18: "123456000000000000000",
      nonce: "1700000000000",
      quantity: "2500000",
      bases: 2,
      side: 1,
      tif: 1,
    });
    expect(order.expiry).toBe(String(1_700_000_000 + 30 * 86_400));
  });

  test("rejects empty, negative, and over-precision inputs", () => {
    expect(previewOrder("", "100", form).valid).toBe(false);
    expect(previewOrder("-1", "100", form).valid).toBe(false);
    expect(previewOrder("1.0000001", "100", form).valid).toBe(false);
    expect(previewOrder("1", "100.0000000000000000001", form).valid).toBe(false);
  });
});
