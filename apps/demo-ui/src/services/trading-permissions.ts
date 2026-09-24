import { permission } from "@/protocol/engine";

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

export async function fetchTradingPermission(_owner: string): Promise<TradingPermission> {
  return permission();
}
