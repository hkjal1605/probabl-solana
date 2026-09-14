let healthyUntil = 0;
import type { PositionView, WholeBalanceView } from "../types/api";
import { assertMarketUnits } from "@conditional-stocks/domain";
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
  for (const [mint, balance] of Object.entries(value.balances) as [string, any][]) {
    if (
      !address(mint) ||
      balance.account !== owner ||
      balance.token !== mint ||
      !Number.isInteger(balance.decimals) ||
      balance.decimals < 0 ||
      balance.decimals > 255 ||
      !amount(balance.canonicalBalance) ||
      !amount(balance.blockNumber) ||
      !balance.creditBalances ||
      Object.entries(balance.creditBalances).some(([id, n]) => !address(id) || !amount(n))
    )
      throw new Error("Invalid streamed balance");
  }
  for (const p of value.positions) {
    if (
      !address(p.marketId) ||
      p.conditionId !== p.marketId ||
      typeof p.redeemable !== "boolean" ||
      [p.stockYes, p.stockNo, p.quoteYes, p.quoteNo].some((n) => !amount(n, 65))
    )
      throw new Error("Invalid streamed position");
    assertMarketUnits(p);
  }
  return value;
}
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
