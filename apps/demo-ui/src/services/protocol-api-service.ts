import {
  listTrades,
  readiness as readReadiness,
  resolution as readResolution,
} from "@/protocol/engine";
import type { ResolutionView, TradeView } from "../types/api";

export { ApiError, requestJson } from "./api";

export const api = {
  trades: async (marketId?: string, _signal?: AbortSignal): Promise<{ trades: TradeView[] }> => ({
    trades: listTrades(marketId),
  }),
  resolution: async (marketId: string, _signal?: AbortSignal): Promise<ResolutionView | null> =>
    readResolution(marketId),
  readiness: async (marketId: string, _signal?: AbortSignal) => readReadiness(marketId),
};
