import { requestJson } from "./api";

export interface TradingPermission {
  owner: string;
  available: boolean;
  delegate: string | null;
  active: boolean;
  slot: string;
  quoteMint: string;
  quoteDecimals: number | null;
  grant: null | {
    market: string;
    expiresAt: string;
    maxOrderQuote: string;
    remainingQuote: string;
    maxFeeBps: number;
    permissions: number;
    revoked: boolean;
  };
}
export function fetchTradingPermission(owner: string, signal?: AbortSignal) {
  return requestJson<TradingPermission>(`/v1/trading/permission?owner=${encodeURIComponent(owner)}`,
    signal ? { signal } : {});
}
