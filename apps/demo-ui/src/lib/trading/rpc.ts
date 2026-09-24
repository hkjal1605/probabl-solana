import { readiness } from "@/protocol/engine";
import type { MarketView } from "@/types/api";

/** The indexed market is the canonical record in this build. */
export async function readClaimMarket(market: MarketView) {
  return { conditionId: market.id, lifecycle: market.lifecycle };
}

export async function transactionReceipt(_signature: string) {
  return { status: "success" as const, blockNumber: 0n };
}

export const marketReadiness = readiness;
