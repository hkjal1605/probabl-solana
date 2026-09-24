import { parseTokenAmount } from "@conditional-stocks/domain";
import { approveTrading, revokeTrading } from "@/protocol/engine";
import type { TradingPermission } from "@/services/trading-permissions";
import { type ProtocolTransaction, transaction } from "./transaction";

export const DEFAULT_MAX_ORDER_QUOTE = "1000";
export const DEFAULT_TOTAL_QUOTE = "10000";
const MAX_TOKEN_AMOUNT = (1n << 64n) - 1n;

export function tradingPermissionApproval(input: {
  owner: string;
  permission: TradingPermission;
  perOrder?: string;
  total?: string;
}): ProtocolTransaction {
  const { owner, permission } = input;
  if (permission.owner !== owner) throw new Error("Trading permission belongs to another wallet");
  if (!permission.available || !permission.delegate || permission.quoteDecimals === null)
    throw new Error("Trading approval is not available for this deployment");
  if (permission.active) throw new Error("Trading is already enabled");
  if (permission.grant)
    throw new Error(
      "This trading approval is expired, revoked, or exhausted. A new protocol trading key is required.",
    );
  const perOrder = (input.perOrder ?? DEFAULT_MAX_ORDER_QUOTE).trim();
  const total = (input.total ?? DEFAULT_TOTAL_QUOTE).trim();
  const maxOrderQuote = parseTokenAmount(perOrder, permission.quoteDecimals);
  const totalQuote = parseTokenAmount(total, permission.quoteDecimals);
  if (maxOrderQuote <= 0n || totalQuote < maxOrderQuote || totalQuote > MAX_TOKEN_AMOUNT)
    throw new Error("Set a positive per-order limit and a larger lifetime limit");
  return transaction(`approve trading up to ${total} per lifetime`, () =>
    approveTrading(perOrder, total),
  );
}

export function tradingPermissionRevocation(input: {
  owner: string;
  permission: TradingPermission;
}): ProtocolTransaction {
  if (input.permission.owner !== input.owner)
    throw new Error("Trading permission belongs to another wallet");
  return transaction("revoke trading permission", () => revokeTrading());
}
