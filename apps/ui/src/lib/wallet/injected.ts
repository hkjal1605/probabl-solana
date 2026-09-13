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
  if (silent && handle.kind === "injected" && !p.isPhantom && !p.isSolflare) {
    // Never assume an unknown provider supports onlyIfTrusted: it might open a popup.
    if (p.publicKey && p.isConnected === true) return p.publicKey.toBase58();
    throw new Error("Connect this wallet manually to restore its saved session.");
  }
  const result = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
  const owner = (result?.publicKey ?? p.publicKey)?.toBase58();
  if (!owner || p.publicKey?.toBase58() !== owner)
    throw new Error("Wallet changed during connection");
  return owner;
}

declare global {
  interface Window extends WalletSources {}
}
