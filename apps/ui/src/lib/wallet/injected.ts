import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { WalletKind } from "./session";

export interface SolanaWallet {
  publicKey: PublicKey | null;
  isConnected?: boolean;
  isPhantom?: boolean;
  isSolflare?: boolean;
  connect(options?: { onlyIfTrusted: true }): Promise<{ publicKey: PublicKey } | undefined>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  on?(event: string, callback: () => void): void;
  removeListener?(event: string, callback: () => void): void;
}
export interface WalletSources {
  phantom?: { solana?: SolanaWallet };
  solflare?: SolanaWallet;
  solana?: SolanaWallet;
}
export interface WalletHandle {
  kind: WalletKind;
  provider: SolanaWallet;
}
export function availableWallets(sources: WalletSources): WalletHandle[] {
  const handles: WalletHandle[] = [];
  for (const kind of ["phantom", "solflare", "injected"] as const) {
    const handle = findWallet(sources, kind);
    if (!handle || handles.some(({ provider }) => provider === handle.provider)) continue;
    if (
      kind === "injected" &&
      handles.some(
        ({ kind: known }) =>
          (known === "phantom" && handle.provider.isPhantom) ||
          (known === "solflare" && handle.provider.isSolflare),
      )
    )
      continue;
    handles.push(handle);
  }
  return handles;
}
export function findWallet(sources: WalletSources, preferred?: WalletKind): WalletHandle | null {
  const choices = {
    phantom: sources.phantom?.solana,
    solflare: sources.solflare,
    injected: sources.solana,
  };
  if (preferred)
    return choices[preferred] ? { kind: preferred, provider: choices[preferred] } : null;
  for (const kind of ["phantom", "solflare", "injected"] as const)
    if (choices[kind]) return { kind, provider: choices[kind] };
  return null;
}

export async function connectWallet(handle: WalletHandle, silent: boolean) {
  const p = handle.provider;
  if (!silent && p.isConnected === true && p.publicKey) return p.publicKey.toBase58();
  if (silent && handle.kind === "injected" && !p.isPhantom && !p.isSolflare) {
    // Never assume an unknown provider supports onlyIfTrusted: it might open a popup.
    if (p.publicKey && p.isConnected === true) return p.publicKey.toBase58();
    throw new Error("Connect this wallet manually to restore its saved session.");
  }
  let result: { publicKey: PublicKey } | undefined;
  try {
    result = silent ? await p.connect({ onlyIfTrusted: true }) : await p.connect();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (/^unexpected error\.?$/i.test(message.trim())) {
      const name =
        handle.kind === "phantom" ? "Phantom" : handle.kind === "solflare" ? "Solflare" : "Wallet";
      throw new Error(`${name} could not open a connection. Unlock the extension and try again.`, {
        cause,
      });
    }
    throw cause;
  }
  const owner = (result?.publicKey ?? p.publicKey)?.toBase58();
  if (!owner || p.publicKey?.toBase58() !== owner)
    throw new Error("Wallet changed during connection");
  return owner;
}

declare global {
  interface Window extends WalletSources {}
}
