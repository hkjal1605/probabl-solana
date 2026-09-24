import { payouts as readPayouts, walletSnapshot } from "@/protocol/engine";
import type { PayoutCreditView } from "@/types/api";

export interface PayoutPage {
  vault: string;
  payouts: PayoutCreditView[];
  nextCursor: string | null;
}
export const getPositions = async (_owner: string, _signal?: AbortSignal) => walletSnapshot();
export const getPayouts = async (_owner: string, _signal?: AbortSignal): Promise<PayoutPage> =>
  readPayouts();
