import { expect, test } from "bun:test";
import { Hono } from "hono";
import { bn } from "@conditional-stocks/solana-client";
import { ReadCache } from "@conditional-stocks/shared/read-cache";
import { DEVNET_ASSET_MINTS } from "@conditional-stocks/shared/spot-prices";
import { mountTradingReadiness } from "../src/readiness";

function fixture() {
  let now = 100_000,
    configReads = 0,
    marketReads = 0,
    networks = 0;
  let paused = false,
    fail = false,
    state = 2,
    open = 0,
    cutoff = 1000;
  const app = new Hono();
  const client = {
    assertNetwork: async () => {
      networks++;
      if (fail) throw new Error("private RPC failure");
    },
    configAccount: async () => {
      configReads++;
      return { paused };
    },
    market: async () => {
      marketReads++;
      return { state, terms: { trading_open: bn(open), trading_cutoff: bn(cutoff) } };
    },
  } as unknown as Parameters<typeof mountTradingReadiness>[1];
  mountTradingReadiness(app, client, new ReadCache(2000, 256, 1000, () => now), () => now);
  return {
    request: () => app.request(`/v1/system/readiness?marketId=${DEVNET_ASSET_MINTS.SOL}`),
    app,
    calls: () => ({ configReads, marketReads, networks }),
    set: (v: {
      now?: number;
      paused?: boolean;
      fail?: boolean;
      state?: number;
      open?: number;
      cutoff?: number;
    }) => {
      now = v.now ?? now;
      paused = v.paused ?? paused;
      fail = v.fail ?? fail;
      state = v.state ?? state;
      open = v.open ?? open;
      cutoff = v.cutoff ?? cutoff;
    },
  };
}
test("readiness deduplicates polling across clients without caching transaction preparation", async () => {
  const f = fixture();
  const rows = await Promise.all(Array.from({ length: 100 }, () => f.request()));
  expect(f.calls()).toEqual({ configReads: 1, marketReads: 1, networks: 1 });
  for (const row of rows) {
    expect(row.status).toBe(200);
    expect((await row.json()).healthy).toBe(true);
  }
  f.set({ now: 102_000, paused: true });
  const response = await f.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ healthy: false, reason: "paused" });
});
test("RPC failures are unavailable, never closed; stale healthy cache is not reused", async () => {
  const f = fixture();
  await f.request();
  f.set({ now: 102_000, fail: true });
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("2");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).toContain('"reason":"unavailable"');
  expect(body).not.toContain("private");
  await f.request();
  expect(f.calls().networks).toBe(2);
  f.set({ now: 103_000, fail: false });
  expect((await (await f.request()).json()).healthy).toBe(true);
});
test("cutoff and opening boundaries are evaluated at response time, even inside cache TTL", async () => {
  const f = fixture();
  f.set({ open: 101, cutoff: 102 });
  expect((await (await f.request()).json()).reason).toBe("scheduled");
  f.set({ now: 101_000 });
  expect((await (await f.request()).json()).reason).toBe("ready");
  f.set({ now: 101_999 });
  expect((await (await f.request()).json()).reason).toBe("ready");
  f.set({ now: 102_000 });
  expect((await (await f.request()).json()).reason).toBe("closed");
  for (const state of [1, 3, 4, 5, 6, 7]) {
    const next = fixture();
    next.set({ state });
    const response = await next.request();
    expect(response.status).toBe(200);
    expect((await response.json()).reason).toBe(state === 1 ? "scheduled" : "closed");
  }
});
test("bad market addresses are rejected before any RPC", async () => {
  const f = fixture();
  expect((await f.app.request("/v1/system/readiness?marketId=bad")).status).toBe(400);
  expect(f.calls().networks).toBe(0);
});
