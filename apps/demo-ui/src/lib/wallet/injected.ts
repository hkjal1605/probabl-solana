import type { WalletKind } from "./session";

export interface WalletHandle {
  kind: WalletKind;
  provider: null;
}

/** A single self-custodied signer is available in this build. */
export function availableWallets(_sources: unknown): WalletHandle[] {
  return [];
}
