import { describe, expect, test } from "bun:test";
import { assertWalletContext, toRpcQuantity } from "@conditional-stocks/ui-kit/transaction";
import { createOrder, previewOrder } from "@/lib/trading/order";

const form = {
  baseTokenDecimals: 18,
  quoteTokenDecimals: 6,
  protocolVersion: 2,
  priceFormat: "raw-unit-ratio-x18" as const,
  account: "0x1000000000000000000000000000000000000001",
  branch: "NO" as const,
  cutoff: "2027-01-01T00:00:00.000Z",
  funding: "claim" as const,
  marketId: `0x${"11".repeat(32)}`,
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
  test("uses exact raw-unit ratio math for 18-decimal stocks and 6-decimal USDC", () => {
    expect(previewOrder("2.5", "123.456", form)).toEqual({
      cost: 308.64,
      costRaw: "308640000",
      priceRawX18: "123456000",
      qty: 2.5,
      quantityRaw: "2500000000000000000",
      valid: true,
    });
  });

  test("builds the exact immutable wire order reviewed by the signer", () => {
    const order = createOrder(form, {
      nowMs: 1_700_000_000_000,
      salt: `0x${"22".repeat(32)}`,
    });
    expect(order).toMatchObject({
      branch: 1,
      fundingKind: 1,
      limitPriceRawX18: "123456000",
      nonce: "1700000000000",
      quantity: "2500000000000000000",
      side: 1,
      tif: 1,
    });
    expect(order.expiry).toBe(String(1_700_000_000 + 30 * 86_400));
  });

  test("rejects empty, negative, and over-precision inputs", () => {
    expect(previewOrder("", "100", form).valid).toBe(false);
    expect(previewOrder("-1", "100", form).valid).toBe(false);
    expect(previewOrder("1.0000000000000000001", "100", form).valid).toBe(false);
    expect(previewOrder("1", "100.0000001", form).valid).toBe(false);
  });
});

describe("wallet transaction quantities", () => {
  test("signing and sending reject changed accounts and networks", async () => {
    let chain = "0x7a69";
    let account = form.account;
    const provider = {
      request: async ({ method }: { method: string }) =>
        method === "eth_accounts" ? [account] : chain,
    };
    await assertWalletContext(provider, form.account, 31337);
    chain = "0x1";
    await expect(assertWalletContext(provider, form.account, 31337)).rejects.toThrow("network");
    chain = "0x7a69";
    account = "0x2000000000000000000000000000000000000002";
    await expect(assertWalletContext(provider, form.account, 31337)).rejects.toThrow("account");
  });
  test("normalizes API decimal values to strict EIP-1193 hex quantities", () => {
    expect(toRpcQuantity(undefined)).toBe("0x0");
    expect(toRpcQuantity("0")).toBe("0x0");
    expect(toRpcQuantity("16")).toBe("0x10");
    expect(toRpcQuantity("0x0010")).toBe("0x10");
    expect(() => toRpcQuantity("-1")).toThrow();
  });
});
