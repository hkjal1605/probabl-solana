export type WalletKind = "phantom" | "solflare" | "injected";

export const WALLET_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_EXPIRED_EVENT = "probabl:ui-session-expired";

export interface SavedWalletSession {
  owner: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

let active: SavedWalletSession | null = null;

export function setRequestSession(value: SavedWalletSession | null) {
  active = value;
}

export function assertRequestSession(token: string, now = Date.now()) {
  if (!active || token !== active.token || now < active.issuedAt || now >= active.expiresAt)
    throw new Error("Your trading session expired. Sign in again.");
}

/** Session tokens are generated locally and never leave the browser. */
export function createWalletSession(owner: string, now = Date.now()): SavedWalletSession {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return {
    owner,
    token: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    issuedAt: now,
    expiresAt: now + WALLET_SESSION_MS,
  };
}
