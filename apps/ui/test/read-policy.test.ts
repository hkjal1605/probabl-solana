import { expect, test } from "bun:test";
import { retainBookDisplays } from "../src/lib/markets/refresh";
import { marketPriceBound } from "../src/lib/trading/entry";
import {
  localTradingStatus,
  readinessMessage,
  requireTradingReady,
} from "../src/lib/trading/readiness";
import { ApiError } from "../src/services/protocol-api-service";
import {
  readFreshness,
  readPollInterval,
  readRetryDelay,
  retryAfterMs,
  retryRead,
} from "../src/services/read-policy";
import { fixtureMarkets } from "./fixtures/protocol";

test("read retries are bounded, honor Retry-After, and never retry auth, schema or abort errors", () => {
  for (const status of [408, 429, 502, 503, 504])
    expect(retryRead(0, new ApiError("read", status, null))).toBe(true);
  for (const status of [400, 401, 403, 404, 409, 422])
    expect(retryRead(0, new ApiError("read", status, null))).toBe(false);
  expect(retryRead(2, new ApiError("read", 503, null))).toBe(false);
  expect(retryRead(0, new Error("malformed response"))).toBe(false);
  expect(retryRead(0, new DOMException("cancelled", "AbortError"))).toBe(false);
  expect(retryRead(0, new TypeError("offline"))).toBe(true);
  expect(retryAfterMs("5")).toBe(5000);
  expect(retryAfterMs("9999999")).toBe(60_000);
  expect(retryAfterMs("bad")).toBeUndefined();
  expect(retryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1000)).toBe(4000);
  expect(readRetryDelay(0, new ApiError("rate", 429, null, 5000))).toBe(5000);
  expect(readPollInterval({ state: { status: "error", fetchFailureCount: 3 } })).toBe(30_000);
});
test("background errors preserve known display data but immediately block stale-data shortcuts", () => {
  const state = { data: { positions: [] }, dataUpdatedAt: 1000, isError: false, failureCount: 0 };
  expect(readFreshness(state, 1500)).toEqual({
    isInitialError: false,
    isRefreshError: false,
    isDataFresh: true,
  });
  expect(readFreshness({ ...state, isError: true }, 1500)).toEqual({
    isInitialError: false,
    isRefreshError: true,
    isDataFresh: false,
  });
  expect(readFreshness({ ...state, failureCount: 1 }, 1500).isDataFresh).toBe(false);
  expect(readFreshness(state, 31_001).isDataFresh).toBe(false);
  expect(readFreshness(state, 999).isDataFresh).toBe(false);
  expect(
    readFreshness({ ...state, data: { observedAt: 1 }, dataUpdatedAt: 40_000 }, 40_001).isDataFresh,
  ).toBe(false);
  expect(readFreshness({ ...state, data: { observedAt: "bad" } }, 1500).isDataFresh).toBe(false);
  expect(readFreshness({ ...state, data: undefined, isError: true }, 1500).isInitialError).toBe(
    true,
  );
});
test("local trading window and connection failures never mislabel an open market as closed", () => {
  const market = {
    ...fixtureMarkets[0]!,
    lifecycle: "open" as const,
    tradingOpen: new Date(1000).toISOString(),
    cutoff: new Date(5000).toISOString(),
  };
  expect(localTradingStatus(market, 999)).toBe("scheduled");
  expect(localTradingStatus(market, 1000)).toBe("ready");
  expect(localTradingStatus(market, 5000)).toBe("closed");
  expect(localTradingStatus({ ...market, cutoff: "invalid" }, 1000)).toBe("unavailable");
  expect(readinessMessage("unavailable")).not.toMatch(/closed|paused/);
  expect(readinessMessage("closed")).toContain("closed");
});
test("every action rechecks readiness; closure during a read and transport failures stay blocked", async () => {
  let now = 2000,
    calls = 0;
  const market = {
    ...fixtureMarkets[0]!,
    lifecycle: "open" as const,
    tradingOpen: new Date(1000).toISOString(),
    cutoff: new Date(5000).toISOString(),
  };
  const read = async () => {
    calls++;
    return { healthy: true };
  };
  await requireTradingReady(market, read, () => now);
  await requireTradingReady(market, read, () => now);
  expect(calls).toBe(2);
  await expect(
    requireTradingReady(
      market,
      async () => {
        throw new Error("RPC failed");
      },
      () => now,
    ),
  ).rejects.toThrow("Cannot verify");
  await expect(
    requireTradingReady(
      market,
      async () => ({ healthy: false, reason: "paused" }),
      () => now,
    ),
  ).rejects.toThrow("paused");
  await expect(
    requireTradingReady(
      market,
      async () => {
        now = 5000;
        return { healthy: true };
      },
      () => now,
    ),
  ).rejects.toThrow("closed");
  await expect(requireTradingReady(market, read, () => now)).rejects.toThrow("closed");
  expect(calls).toBe(2);
});
test("partial book refresh retains rows only for identical assets, without making them executable", () => {
  const market = fixtureMarkets[0]!;
  const next = { ...market, bookQuality: "unavailable" as const, yes: { ...market.yes, asks: [] } };
  const merged = retainBookDisplays({ markets: [market] }, { markets: [next] }).markets[0]!;
  expect(merged.yes).toBe(market.yes);
  expect(merged.bookQuality).toBe("unavailable");
  expect(() => marketPriceBound(merged, "YES", "buy")).toThrow("fresh order book");
  expect(
    retainBookDisplays({ markets: [market] }, { markets: [{ ...next, baseToken: "different" }] })
      .markets[0]!.yes,
  ).toBe(next.yes);
});
