import { PublicKey } from "@solana/web3.js";

type Deployment = { programId?: string; config: string; genesisHash: string };

export const WALLET_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const WALLET_STORAGE_KEY = "probabl:ui:wallet:v1";
export const SESSION_STORAGE_KEY = "probabl:ui:session:v1";
export type WalletKind = "phantom" | "solflare" | "injected";
export interface RememberedWallet {
  version: 1;
  kind: WalletKind;
  owner: string;
}
export interface SavedWalletSession {
  version: 1;
  binding: string;
  owner: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}
export type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserStorage(): SessionStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
export const sessionBinding = (
  deployment: Pick<Deployment, "programId" | "config" | "genesisHash">,
  origin: string,
) => JSON.stringify([origin, deployment.genesisHash, deployment.programId, deployment.config]);

function read(storage: SessionStorage | null, name: string): unknown {
  try {
    const raw = storage?.getItem(name);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(storage: SessionStorage | null, name: string, value: unknown) {
  try {
    if (!storage) return false;
    storage.setItem(name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function forget(storage: SessionStorage | null, name: string) {
  try {
    storage?.removeItem(name);
  } catch {
    /* Memory session is still cleared if storage is unavailable. */
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const ownerAddress = (value: unknown): value is string => {
  try {
    return typeof value === "string" && new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

export function rememberedWallet(storage: SessionStorage | null): RememberedWallet | null {
  const value = read(storage, WALLET_STORAGE_KEY);
  if (
    !object(value) ||
    value.version !== 1 ||
    !["phantom", "solflare", "injected"].includes(String(value.kind)) ||
    !ownerAddress(value.owner)
  )
    return null;
  return value as unknown as RememberedWallet;
}
export function rememberWallet(storage: SessionStorage | null, kind: WalletKind, owner: string) {
  if (!ownerAddress(owner)) throw new Error("Invalid wallet address");
  return write(storage, WALLET_STORAGE_KEY, { version: 1, kind, owner });
}

export function createWalletSession(
  binding: string,
  owner: string,
  token: unknown,
  now = Date.now(),
  upstreamExpiresAtMs?: unknown,
): SavedWalletSession {
  if (
    !ownerAddress(owner) ||
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(now + WALLET_SESSION_MS)
  )
    throw new Error("API returned an invalid Solana session");
  let expiresAt = now + WALLET_SESSION_MS;
  if (upstreamExpiresAtMs !== undefined) {
    const limit =
      typeof upstreamExpiresAtMs === "string" && /^[0-9]{1,16}$/.test(upstreamExpiresAtMs)
        ? Number(upstreamExpiresAtMs)
        : upstreamExpiresAtMs;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= now)
      throw new Error("API returned an expired or invalid session lifetime");
    expiresAt = Math.min(expiresAt, limit);
  }
  return { version: 1, binding, owner, token, issuedAt: now, expiresAt };
}

export function savedWalletSession(
  storage: SessionStorage | null,
  binding: string,
  owner: string,
  now = Date.now(),
): SavedWalletSession | null {
  if (!Number.isSafeInteger(now) || now < 0) return null;
  const value = read(storage, SESSION_STORAGE_KEY);
  if (
    !object(value) ||
    value.version !== 1 ||
    value.binding !== binding ||
    value.owner !== owner ||
    !ownerAddress(value.owner) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    typeof value.issuedAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < 0 ||
    value.issuedAt > now ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt <= value.issuedAt ||
    value.expiresAt > value.issuedAt + WALLET_SESSION_MS
  )
    return null;
  return value as unknown as SavedWalletSession;
}
export const persistWalletSession = (storage: SessionStorage | null, session: SavedWalletSession) =>
  write(storage, SESSION_STORAGE_KEY, session);

// A request-time guard also covers background tabs whose expiry timers were throttled.
export const SESSION_EXPIRED_EVENT = "probabl:ui-session-expired";
let active: SavedWalletSession | null = null;
let assertIdentity: (() => void) | undefined;
export function setRequestSession(value: SavedWalletSession | null, checkIdentity?: () => void) {
  active = value;
  assertIdentity = checkIdentity;
}
export function assertRequestSession(token: string, now = Date.now()) {
  if (
    !Number.isSafeInteger(now) ||
    !active ||
    token !== active.token ||
    now < active.issuedAt ||
    now >= active.expiresAt
  )
    throw new Error("Your trading session expired. Sign in again.");
  assertIdentity?.();
}
