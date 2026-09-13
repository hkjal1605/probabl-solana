import { assertRequestSession, SESSION_EXPIRED_EVENT } from "../wallet/session";
import { mergeOrderPages, type OrdersPage } from "./orders";
import type {
  MarketView,
  PositionView,
  ResolutionView,
  TradeView,
  WholeBalanceView,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Same-origin transport. Never retry mutations or log session tokens / signed payloads. */
export async function requestJson<T>(
  path: string,
  options: { signal?: AbortSignal; token?: string; body?: unknown } = {},
): Promise<T> {
  if (!path.startsWith("/api/") || path.includes("\\")) throw new Error("Invalid API path");
  if (options.token && typeof window !== "undefined") {
    try {
      assertRequestSession(options.token);
    } catch {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: options.token }));
      throw new ApiError(
        "Your trading session expired or wallet changed. Sign in again.",
        401,
        null,
      );
    }
  }
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(path, {
    method: options.body === undefined ? "GET" : "POST",
    cache: "no-store",
    redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    if (response.status === 401 && options.token && typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: options.token }));
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    const message =
      error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : `Data unavailable (${response.status})`;
    throw new ApiError(message, response.status, response.headers.get("x-request-id"));
  }
  return response.json() as Promise<T>;
}

export const api = {
  markets: (signal?: AbortSignal) =>
    requestJson<{ markets: MarketView[] }>("/api/markets", signal ? { signal } : {}),
  orders: async (account: string, signal?: AbortSignal) => {
    const path = `/api/indexer/orders?maker=${encodeURIComponent(account)}&limit=1000`;
    const [recent, open] = await Promise.all([
      requestJson<OrdersPage>(path, signal ? { signal } : {}),
      requestJson<OrdersPage>(`${path}&status=open`, signal ? { signal } : {}),
    ]);
    return mergeOrderPages(recent, open);
  },
  positions: (account: string, signal?: AbortSignal) =>
    requestJson<{ positions: PositionView[] }>(
      `/api/indexer/positions/${encodeURIComponent(account)}`,
      signal ? { signal } : {},
    ),
  balance: (account: string, token: string, signal?: AbortSignal) =>
    requestJson<WholeBalanceView>(
      `/api/indexer/balances/${encodeURIComponent(account)}?token=${encodeURIComponent(token)}`,
      signal ? { signal } : {},
    ),
  trades: (marketId: string, signal?: AbortSignal) =>
    requestJson<{ trades: TradeView[] }>(
      `/api/indexer/trades?marketId=${encodeURIComponent(marketId)}&limit=100`,
      signal ? { signal } : {},
    ),
  prepare: <T>(path: string, body: unknown, token: string) =>
    requestJson<T>(`/api/gateway/${path}`, { body, token }),
  resolution: async (marketId: string, signal?: AbortSignal) => {
    try {
      return await requestJson<ResolutionView>(
        `/api/indexer/resolutions/${encodeURIComponent(marketId)}`,
        signal ? { signal } : {},
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  readiness: (marketId: string, signal?: AbortSignal) =>
    requestJson<{ healthy: boolean }>(
      `/api/gateway/system/readiness?marketId=${encodeURIComponent(marketId)}`,
      signal ? { signal } : {},
    ),
};
