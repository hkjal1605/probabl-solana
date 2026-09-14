/** GET refresh policy. Mutation requests are never automatically retried. */
import { indexStreamHealthy } from "./index-stream";
type HttpFailure = { status?: number; retryAfterMs?: number; name?: string };
export function retryRead(failures: number, error: unknown) {
  if (failures >= 2) return false;
  const failure = error as HttpFailure | null;
  if (failure?.name === "AbortError") return false;
  if (typeof failure?.status === "number")
    return [408, 429, 500, 502, 503, 504].includes(failure.status);
  return failure?.name === "TypeError" || failure?.name === "TimeoutError";
}
export function readRetryDelay(attempt: number, error: unknown) {
  const hint = (error as HttpFailure | null)?.retryAfterMs;
  return Math.max(Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000), hint ?? 0);
}
export function retryAfterMs(header: string | null, now = Date.now()) {
  if (!header) return undefined;
  const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(60_000, delay)) : undefined;
}
export const readQueryDefaults = {
  refetchOnWindowFocus: false,
  refetchIntervalInBackground: false,
  retry: retryRead,
  retryDelay: readRetryDelay,
  staleTime: 10_000,
};
export function readPollInterval(query: {
  queryKey?: readonly unknown[];
  state: { status: string; fetchFailureCount: number };
}) {
  if (
    query.state.status === "success" &&
    indexStreamHealthy() &&
    [
      "markets",
      "wallet-orders",
      "trades",
      "positions",
      "whole-balances",
      "trading-readiness",
    ].includes(String(query.queryKey?.[0]))
  )
    return false;
  return query.state.status === "error" ? 30_000 : 10_000;
}
export interface ReadState {
  data: unknown;
  dataUpdatedAt: number;
  isError: boolean;
  failureCount: number;
}
export function readFreshness(query: ReadState, now = Date.now(), maxAgeMs = 30_000) {
  const hasData = query.data !== undefined;
  const observedAt =
    query.data && typeof query.data === "object" && "observedAt" in query.data
      ? query.data.observedAt
      : undefined;
  const sourceExpired =
    observedAt !== undefined &&
    (typeof observedAt !== "number" ||
      !Number.isSafeInteger(observedAt) ||
      observedAt <= 0 ||
      observedAt > now + 5000 ||
      now - observedAt > maxAgeMs);
  const expired =
    hasData &&
    (sourceExpired ||
      query.dataUpdatedAt <= 0 ||
      now < query.dataUpdatedAt ||
      now - query.dataUpdatedAt > maxAgeMs);
  return {
    isInitialError: query.isError && !hasData,
    isRefreshError: hasData && (query.isError || query.failureCount > 0 || expired),
    isDataFresh: hasData && !query.isError && query.failureCount === 0 && !expired,
  };
}
