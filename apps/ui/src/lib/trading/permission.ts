import { parseTokenAmount } from "@conditional-stocks/domain";
import {
  DELEGATE_TRADE,
  envelope,
  key,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import type { TradingPermission } from "@/services/trading-permissions";

export const DEFAULT_MAX_ORDER_QUOTE = "1000";
export const DEFAULT_TOTAL_QUOTE = "10000";
const MAX_TOKEN_AMOUNT = (1n << 64n) - 1n;

export function tradingPermissionApproval(input: {
  client: SolanaClient;
  owner: string;
  permission: TradingPermission;
  perOrder?: string;
  total?: string;
  nowSeconds?: bigint;
}) {
  const { client, owner, permission } = input;
  if (permission.owner !== owner) throw new Error("Trading permission belongs to another wallet");
  if (!permission.available || !permission.delegate || permission.quoteDecimals === null)
    throw new Error("Trading approval is not available for this deployment");
  if (permission.active) throw new Error("Trading is already enabled");
  if (permission.grant)
    throw new Error(
      "This trading approval is expired, revoked, or exhausted. A new protocol trading key is required.",
    );
  const maxOrderQuote = parseTokenAmount(
    (input.perOrder ?? DEFAULT_MAX_ORDER_QUOTE).trim(),
    permission.quoteDecimals,
  );
  const totalQuote = parseTokenAmount(
    (input.total ?? DEFAULT_TOTAL_QUOTE).trim(),
    permission.quoteDecimals,
  );
  if (maxOrderQuote <= 0n || totalQuote < maxOrderQuote || totalQuote > MAX_TOKEN_AMOUNT)
    throw new Error("Set a positive per-order limit and a larger lifetime limit");
  const now = input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  return envelope(
    [
      client.approveDelegate(key(owner), key(permission.delegate), {
        market: null,
        expiresAt: now + 90n * 86_400n,
        maxOrderQuote,
        totalQuote,
        maxFeeBps: 100,
        permissions: DELEGATE_TRADE,
      }),
    ],
    client.program,
  );
}
