import type { IndexedOrder } from "@/types/api";

const STORAGE_KEY = "probabl:account:v1";

export interface StoredWallet {
  connected: boolean;
  external: Record<string, string>;
  vault: Record<string, string>;
  claims: Record<string, Record<string, string>>;
  externalClaims: Record<string, Record<string, string>>;
  orders: IndexedOrder[];
  permission: null | {
    granted: boolean;
    revoked: boolean;
    expiresAt: string;
    maxOrderQuote: string;
    totalQuote: string;
    remainingQuote: string;
  };
}

/** Balances and orders survive a reload; everything stays on this device. */
export function loadWalletState(): StoredWallet | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredWallet;
    if (typeof value !== "object" || value === null || typeof value.connected !== "boolean")
      return null;
    return {
      connected: value.connected,
      external: value.external ?? {},
      vault: value.vault ?? {},
      claims: value.claims ?? {},
      externalClaims: value.externalClaims ?? {},
      orders: Array.isArray(value.orders) ? value.orders : [],
      permission: value.permission ?? null,
    };
  } catch {
    return null;
  }
}

export function saveWalletState(value: StoredWallet) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* A full or blocked storage quota must not break the session in memory. */
  }
}

export function clearWalletState() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing to clear when storage is unavailable. */
  }
}
