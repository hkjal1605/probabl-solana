import { listMarkets } from "@/protocol/engine";
import type { MarketView } from "../types/api";

async function liveMarkets(marketId?: string, _signal?: AbortSignal): Promise<MarketView[]> {
  return listMarkets(marketId);
}

export const marketsApi = { liveMarkets };
