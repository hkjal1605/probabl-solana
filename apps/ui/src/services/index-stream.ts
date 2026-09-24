let healthyUntil = 0;

import { SHARE_PROTOCOL_VERSION, tokenDecimals } from "@conditional-stocks/domain";
import { MAX_BASES } from "@conditional-stocks/solana-client";
import type { PositionView, WholeBalanceView } from "../types/api";

const address = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const amount = (v: unknown, bits = 64) =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,39})$/.test(v) && BigInt(v) < 1n << BigInt(bits);
export interface StreamWallet {
  owner: string;
  observedAt: number;
  blockNumber: string;
  positions: PositionView[];
  balances: Record<string, WholeBalanceView>;
}
export function parseStreamWallet(value: any, owner: string): StreamWallet {
  if (
    !value ||
    value.owner !== owner ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt > Date.now() + 5000 ||
    Date.now() - value.observedAt > 30_000 ||
    !amount(value.blockNumber) ||
    !Array.isArray(value.positions) ||
    !value.balances ||
    typeof value.balances !== "object"
  )
    throw new Error("Invalid streamed wallet");
  const balances: Record<string, WholeBalanceView> = {};
  for (const [mint, balance] of Object.entries(value.balances) as [string, any][]) {
    const hasAvailable = balance?.vaultAvailable !== undefined;
    const hasReserved = balance?.reserved !== undefined;
    // During an additive indexer rollout, an older image may omit both custody
    // fields. Preserve its independently verified external wallet balance, but
    // fail closed for protocol funds. One missing field is always malformed.
    const vaultAvailable = hasAvailable ? balance.vaultAvailable : "0";
    const reserved = hasReserved ? balance.reserved : "0";
    if (
      !address(mint) ||
      balance.account !== owner ||
      balance.token !== mint ||
      !Number.isInteger(balance.decimals) ||
      balance.decimals < 0 ||
      balance.decimals > 255 ||
      !amount(balance.canonicalBalance) ||
      hasAvailable !== hasReserved ||
      !amount(vaultAvailable) ||
      !amount(reserved) ||
      !amount(balance.blockNumber) ||
      !balance.creditBalances ||
      Object.entries(balance.creditBalances).some(([id, n]) => !address(id) || !amount(n))
    )
      throw new Error("Invalid streamed balance");
    balances[mint] = { ...balance, vaultAvailable, reserved };
  }
  for (const p of value.positions) parsePosition(p);
  return { ...value, balances };
}
/** v3 position: quote claims plus per-issuer claims, each in raw units of its own mint. */
export function parsePosition(p: any): PositionView {
  if (
    !p ||
    !address(p.marketId) ||
    p.conditionId !== p.marketId ||
    typeof p.redeemable !== "boolean" ||
    p.protocolVersion !== SHARE_PROTOCOL_VERSION ||
    [p.quoteYes, p.quoteNo].some((n) => !amount(n, 65)) ||
    !Array.isArray(p.bases) ||
    p.bases.length > MAX_BASES ||
    // Legs whose claims are not initialized yet are omitted; the rest ascend.
    p.bases.some(
      (leg: any, index: number) =>
        !leg ||
        !Number.isInteger(leg.collateral) ||
        leg.collateral < 1 ||
        leg.collateral > MAX_BASES ||
        (index > 0 && leg.collateral <= p.bases[index - 1]?.collateral) ||
        !address(leg.mint) ||
        !amount(leg.yes, 65) ||
        !amount(leg.no, 65),
    )
  )
    throw new Error("Invalid streamed position");
  tokenDecimals(p.shareDecimals);
  tokenDecimals(p.quoteTokenDecimals);
  for (const leg of p.bases) tokenDecimals(leg.decimals);
  return p as PositionView;
}
export const positionHasClaims = (p: PositionView) =>
  [p.quoteYes, p.quoteNo, ...p.bases.flatMap((leg) => [leg.yes, leg.no])].some(
    (value) => BigInt(value) > 0n,
  );
export const setIndexStreamHealthy = (until: number) => {
  healthyUntil = until;
};
export const indexStreamHealthy = () => Date.now() < healthyUntil;

export function parseIndexUpdate(raw: string) {
  const value = JSON.parse(raw);
  if (
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0 ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt > Date.now() + 5000 ||
    Date.now() - value.observedAt > 15_000 ||
    !Array.isArray(value.markets) ||
    !Array.isArray(value.owners) ||
    [...value.markets, ...value.owners].some(
      (id: unknown) => typeof id !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id),
    )
  )
    throw new Error("Invalid index stream update");
  const readiness = value.readiness ?? {};
  if (
    typeof readiness !== "object" ||
    readiness === null ||
    Object.entries(readiness).some(
      ([id, v]: [string, any]) =>
        !address(id) ||
        !v ||
        !["ready", "scheduled", "closed", "paused"].includes(v.reason) ||
        v.healthy !== (v.reason === "ready") ||
        !Number.isSafeInteger(v.checkedAt),
    )
  )
    throw new Error("Invalid streamed readiness");
  return { ...value, readiness } as {
    slot: number;
    observedAt: number;
    markets: string[];
    owners: string[];
    wallet?: unknown;
    readiness: Record<string, unknown>;
  };
}
