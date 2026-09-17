import { ApiError, requestJson } from "./api";

export { ApiError, requestJson } from "./api";

import type { ResolutionView, TradeView } from "../types/api";
export const api = {
  trades: (marketId?: string, signal?: AbortSignal) =>
    requestJson<{ trades: TradeView[] }>(
      marketId
        ? `/trades?marketId=${encodeURIComponent(marketId)}&limit=100`
        : "/trades?limit=1000",
      signal ? { signal } : {},
    ),
  prepare: <T>(path: string, body: unknown, token?: string) =>
    requestJson<T>(`/v1/${path}`, { body, ...(token ? { token } : {}) }),
  resolution: async (marketId: string, signal?: AbortSignal) => {
    try {
      return await requestJson<ResolutionView>(
        `/resolutions/${encodeURIComponent(marketId)}`,
        signal ? { signal } : {},
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  readiness: async (marketId: string, signal?: AbortSignal) => {
    const result = await requestJson<{ healthy: boolean; reason?: string; checkedAt?: number }>(
      `/v1/system/readiness?marketId=${encodeURIComponent(marketId)}`,
      signal ? { signal } : {},
    );
    if (
      typeof result?.healthy !== "boolean" ||
      (result.checkedAt !== undefined &&
        (!Number.isSafeInteger(result.checkedAt) ||
          result.checkedAt <= 0 ||
          result.checkedAt > Date.now() + 5000)) ||
      (result.reason !== undefined &&
        !["ready", "closed", "scheduled", "paused", "unavailable"].includes(result.reason)) ||
      (result.reason !== undefined && result.healthy !== (result.reason === "ready"))
    )
      throw new Error("Invalid trading readiness response");
    return result;
  },
};
