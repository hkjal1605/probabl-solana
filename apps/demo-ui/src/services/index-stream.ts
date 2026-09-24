import type { WalletSnapshot } from "@/protocol/engine";

let healthyUntil = 0;

export type StreamWallet = WalletSnapshot;

export const setIndexStreamHealthy = (until: number) => {
  healthyUntil = until;
};
export const indexStreamHealthy = () => Date.now() < healthyUntil;
