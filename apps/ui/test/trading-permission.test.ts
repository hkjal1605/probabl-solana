import { expect, test } from "bun:test";
import { coder, PublicKey, SolanaClient, unwrap } from "@conditional-stocks/solana-client";
import {
  DEFAULT_MAX_ORDER_QUOTE,
  DEFAULT_TOTAL_QUOTE,
  tradingPermissionApproval,
} from "../src/lib/trading/permission";
import type { TradingPermission } from "../src/services/trading-permissions";

const client = new SolanaClient({
  rpcUrl: "http://127.0.0.1:8899",
  config: String(PublicKey.unique()),
  genesisHash: String(PublicKey.unique()),
});
const owner = String(PublicKey.unique());
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test value");
  return value;
}
const permission = (overrides: Partial<TradingPermission> = {}): TradingPermission => ({
  owner,
  available: true,
  delegate: String(PublicKey.unique()),
  active: false,
  slot: "1",
  quoteMint: String(PublicKey.unique()),
  quoteDecimals: 6,
  grant: null,
  ...overrides,
});

test("trade ticket defaults build one protocol-wide, bounded 90-day approval", () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const transaction = tradingPermissionApproval({
    client,
    owner,
    permission: permission(),
    nowSeconds: now,
  });
  const instructions = unwrap(transaction, client.program);
  expect(instructions).toHaveLength(1);
  const decoded = required(coder.instruction.decode(required(instructions[0]).data));
  const limits = (decoded.data as { limits: Record<string, { toString(): string }> }).limits;
  expect(decoded.name).toBe("approve_delegate");
  expect(required(limits.expires_at).toString()).toBe(String(now + 90n * 86_400n));
  expect(required(limits.max_order_quote).toString()).toBe("1000000000");
  expect(required(limits.total_quote).toString()).toBe("10000000000");
  expect(DEFAULT_MAX_ORDER_QUOTE).toBe("1000");
  expect(DEFAULT_TOTAL_QUOTE).toBe("10000");
});

test("approval rejects foreign, unavailable, active, and non-renewable permissions", () => {
  for (const value of [
    permission({ owner: String(PublicKey.unique()) }),
    permission({ available: false }),
    permission({ active: true }),
    permission({
      grant: {
        market: String(PublicKey.default),
        expiresAt: "1",
        maxOrderQuote: "1",
        remainingQuote: "0",
        maxFeeBps: 0,
        permissions: 1,
        revoked: true,
      },
    }),
  ])
    expect(() => tradingPermissionApproval({ client, owner, permission: value })).toThrow();
});

test("market ticket enables permission in place and reserves portfolio navigation for deposits", async () => {
  const source = await Bun.file(
    new URL("../src/modules/MarketDetailPageModule/components/OrderTicket.tsx", import.meta.url),
  ).text();
  expect(source).toContain("? t.enableTrading()");
  expect(source).toContain("prepared && !prepared.funding.balanceSufficient");
  expect(source.match(/router\.push\("\/portfolio"\)/g)).toHaveLength(1);
});
