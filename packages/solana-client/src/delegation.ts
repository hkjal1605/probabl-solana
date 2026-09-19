import {
  PublicKey,
  U64_MAX,
  big,
  key,
  quote,
  parseOrder,
  type OrderWire,
  type TradingDelegateAccount,
} from "./protocol.ts";

export const DELEGATE_TRADE = 1;
export const DELEGATE_CANCEL = 2;
export const MAX_DELEGATE_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
export interface DelegateLimits {
  /** Explicit null means ALL markets in this deployment. */
  market: PublicKey | null;
  expiresAt: bigint;
  maxOrderQuote: bigint;
  totalQuote: bigint;
  maxFeeBps: number;
  permissions: number;
}
export function validateDelegateLimits(
  limits: DelegateLimits,
  now = BigInt(Math.floor(Date.now() / 1000)),
) {
  if (
    (limits.market !== null && !(limits.market instanceof PublicKey)) ||
    typeof limits.expiresAt !== "bigint" ||
    limits.expiresAt <= now ||
    limits.expiresAt - now > BigInt(MAX_DELEGATE_LIFETIME_SECONDS) ||
    typeof limits.maxOrderQuote !== "bigint" ||
    typeof limits.totalQuote !== "bigint" ||
    limits.maxOrderQuote <= 0n ||
    limits.totalQuote < limits.maxOrderQuote ||
    limits.totalQuote > U64_MAX ||
    !Number.isInteger(limits.maxFeeBps) ||
    limits.maxFeeBps < 0 ||
    limits.maxFeeBps > 1000 ||
    ![DELEGATE_TRADE, DELEGATE_TRADE | DELEGATE_CANCEL].includes(limits.permissions)
  )
    throw new Error("Invalid trading delegation limits");
}
/** Index/UI convenience only. On-chain enforcement is authoritative. Zero
 * remaining budget blocks NEW orders, not fills of already charged orders. */
export function activeDelegation(
  grant: TradingDelegateAccount,
  epoch: bigint,
  market: PublicKey,
  now: bigint,
) {
  return (
    !grant.revoked &&
    big(grant.epoch) === epoch &&
    now < big(grant.expires_at) &&
    (grant.permissions & DELEGATE_TRADE) !== 0 &&
    (grant.market.equals(PublicKey.default) || grant.market.equals(market))
  );
}
export function assertDelegatedOrder(
  order: OrderWire,
  grant: TradingDelegateAccount | undefined,
  epoch: bigint,
  config: PublicKey,
  now: bigint,
) {
  const o = parseOrder(order);
  if (!o.delegate) return;
  if (
    !grant ||
    !grant.config.equals(config) ||
    grant.owner.toBase58() !== o.maker ||
    grant.delegate.toBase58() !== o.delegate ||
    !activeDelegation(grant, epoch, key(o.marketId), now) ||
    BigInt(o.expiry) > big(grant.expires_at) ||
    o.maxFeeBps > grant.max_fee_bps
  )
    throw new Error("Trading delegation is missing, inactive or outside its permissions");
  const notional = quote(BigInt(o.quantity), BigInt(o.limitPriceRawX18), true);
  if (notional > big(grant.max_order_quote) || notional > big(grant.remaining_quote))
    throw new Error("Delegated order exceeds its trading allowance");
}
