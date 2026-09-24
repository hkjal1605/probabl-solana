import { describe, expect, test } from "bun:test";
import {
  DEVNET_ASSET_MINTS as D,
  SOLANA_DEVNET_GENESIS as DEV,
  isSolanaMint,
  MAINNET_REFERENCE_MINTS as M,
  SOLANA_MAINNET_GENESIS as MAIN,
  SPOT_POLL_MS,
  spotMapping,
} from "@conditional-stocks/shared/spot-prices";
import { PublicKey } from "@solana/web3.js";
import { Hono } from "hono";
import {
  JupiterSpotPrices,
  jupiterEnvironment,
  parseJupiterPrice,
} from "../../src/integrations/jupiter/prices.ts";
import {
  mountMarketSpotPrices,
  mountSpotPrices,
} from "../../src/solana/market-data/spot-routes.ts";

const NOW = 1_800_000_000_000;
const valid = { usdPrice: 123.456, decimals: 8, blockId: 100 };
const settings = jupiterEnvironment({
  JUPITER_API_KEY: "test-secret",
  JUPITER_PRICE_RPC_URL: "https://mainnet.example/?api-key=rpc-secret",
});
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
function fixture(genesis: string = DEV) {
  let now = NOW;
  const calls: { url: string; init: RequestInit; at: number }[] = [];
  let prices: (ids: string[]) => Response = (ids) =>
    Response.json(Object.fromEntries(ids.map((id) => [id, valid])));
  let rpc: (request: { id: number; method: string; params?: number[] }[]) => Response = (request) =>
    Response.json(
      request.map((r) => ({
        jsonrpc: "2.0",
        id: r.id,
        result: r.method === "getGenesisHash" ? MAIN : Math.floor(now / 1000) - 5,
      })),
    );
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init, at: now });
    return init.method === "POST"
      ? rpc(JSON.parse(String(init.body)))
      : prices(new URL(url).searchParams.get("ids")!.split(","));
  };
  const service = new JupiterSpotPrices(
    genesis,
    settings,
    fetcher,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  return {
    service,
    calls,
    fetcher,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    prices: (next: typeof prices) => {
      prices = next;
    },
    rpc: (next: typeof rpc) => {
      rpc = next;
    },
    jupiterCalls: () => calls.filter((c) => c.init.method !== "POST"),
  };
}
const mint = (i: number) =>
  new PublicKey(
    Uint8Array.from({ length: 32 }, (_, j) =>
      j === 0 ? i % 256 : j === 1 ? Math.floor(i / 256) : j,
    ),
  ).toBase58();

describe("mint identity", () => {
  test("all seven deployment aliases resolve to exact mainnet issuer mints only on devnet", () => {
    for (const symbol of Object.keys(D) as (keyof typeof D)[]) {
      expect(isSolanaMint(D[symbol])).toBe(true);
      expect(isSolanaMint(M[symbol])).toBe(true);
      expect(spotMapping(DEV, D[symbol]).sourceMint).toBe(M[symbol]);
      expect(spotMapping(MAIN, D[symbol]).sourceMint).toBe(D[symbol]);
      expect(spotMapping("localnet", D[symbol]).sourceMint).toBeNull();
      expect(spotMapping("devnet", D[symbol]).sourceMint).toBeNull();
    }
    expect(spotMapping(DEV, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").sourceMint).toBe(
      M.USDC,
    );
    expect(isSolanaMint(MAIN)).toBe(true); // full genesis, not a truncated explorer chain reference
  });
  test("any mainnet mint is queryable; unknown devnet mints never inherit ticker prices", () => {
    expect(spotMapping(MAIN, mint(99)).sourceMint).toBe(mint(99));
    expect(spotMapping(DEV, mint(99)).sourceMint).toBeNull();
    expect(spotMapping(MAIN, M.NVDA).valuationCompatible).toBe(false);
    expect(spotMapping(DEV, D.SOL).valuationCompatible).toBe(true);
  });
  test("canonical base58 validation rejects malformed lengths, whitespace and object keys", () => {
    for (const value of [
      "",
      "SOL",
      "__proto__",
      "constructor",
      "0".repeat(44),
      "1".repeat(33),
      "z".repeat(44),
      ` ${M.SOL}`,
      null,
      1,
    ])
      expect(isSolanaMint(value)).toBe(false);
    for (let i = 0; i < 100; i++) expect(isSolanaMint(mint(i))).toBe(true);
  });
});

describe("Jupiter transport and validation", () => {
  test("batches seven aliases and deduplicates official/mock USDC; key stays server-side", async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        f.service.getPrices([...Object.values(D), "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]),
      ),
    );
    expect(f.jupiterCalls()).toHaveLength(1);
    const call = f.jupiterCalls()[0]!;
    expect(new URL(call.url).origin).toBe("https://api.jup.ag");
    expect(new URL(call.url).searchParams.get("ids")!.split(",")).toHaveLength(7);
    expect(call.url).not.toContain("test-secret");
    expect(new Headers(call.init.headers).get("x-api-key")).toBe("test-secret");
    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(f.calls[1]!.init.headers).has("x-api-key")).toBe(false);
    expect(results[0]!.prices.every((p) => p.status === "available")).toBe(true);
    expect(results[0]!.sourceGenesisHash).toBe(MAIN);
    expect(JSON.stringify(results)).not.toMatch(/test-secret|rpc-secret|api-key/);
    await f.service.getPrices(Object.values(D));
    expect(f.jupiterCalls()).toHaveLength(1);
    f.advance(SPOT_POLL_MS);
    await f.service.getPrices(Object.values(D));
    expect(f.jupiterCalls()).toHaveLength(2);
    expect(f.calls.filter((c) => c.init.method === "POST")).toHaveLength(1); // immutable block-time cache
  });
  test("more than 50 concurrent mints are bounded, paced and independently completed", async () => {
    const f = fixture(MAIN);
    const all = Array.from({ length: 120 }, (_, i) => mint(i));
    const results = await Promise.all(
      [all.slice(0, 50), all.slice(50, 100), all.slice(100)].map((m) => f.service.getPrices(m)),
    );
    expect(results.flatMap((r) => r.prices)).toHaveLength(120);
    expect(f.jupiterCalls()).toHaveLength(3);
    for (let i = 1; i < 3; i++)
      expect(f.jupiterCalls()[i]!.at - f.jupiterCalls()[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    expect(
      f
        .jupiterCalls()
        .every((c) => new URL(c.url).searchParams.get("ids")!.split(",").length <= 50),
    ).toBe(true);
  });
  test("no configured key and no devnet mapping make no upstream calls", async () => {
    const f = fixture();
    const empty = new JupiterSpotPrices(DEV, { ...settings, apiKey: "" }, f.fetcher);
    expect((await empty.getPrices([D.SOL])).prices[0]!.status).toBe("not-configured");
    expect((await f.service.getPrices([mint(90)])).prices[0]!.status).toBe("unmapped");
    expect(f.calls).toHaveLength(0);
  });
  test("environment errors never include secrets; arbitrary Jupiter endpoints are not configurable", () => {
    expect(jupiterEnvironment({}).apiKey).toBe("");
    expect(() => jupiterEnvironment({ JUPITER_API_KEY: "key\nsecret" })).toThrow(
      "format (value withheld)",
    );
    for (const url of [
      "http://mainnet.example",
      "https://user:secret@mainnet.example",
      "bad-secret",
      "https://rpc.example/#secret",
    ])
      expect(() => jupiterEnvironment({ JUPITER_PRICE_RPC_URL: url })).toThrow("mainnet HTTPS RPC");
  });
  test("missing/null prices remain null; one invalid mint does not hide another", async () => {
    const f = fixture();
    f.prices(() =>
      Response.json({ [M.SOL]: valid, [M.BTC]: null, [M.ETH]: { ...valid, usdPrice: -1 } }),
    );
    const r = await f.service.getPrices([D.SOL, D.BTC, D.ETH, D.USDC]);
    expect(r.prices.map((p) => p.status)).toEqual([
      "available",
      "unavailable",
      "invalid",
      "unavailable",
    ]);
    expect(r.prices.slice(1).every((p) => p.priceUsd === null)).toBe(true);
  });
  const invalidFields = [
    { usdPrice: 0 },
    { usdPrice: -1 },
    { usdPrice: Infinity },
    { usdPrice: NaN },
    { usdPrice: "1" },
    { blockId: 0 },
    { blockId: -1 },
    { blockId: "100" },
    { blockId: 1.5 },
    { blockId: Number.MAX_SAFE_INTEGER + 1 },
    { decimals: -1 },
    { decimals: 256 },
    { decimals: "6" },
    { decimals: 1.5 },
  ];
  invalidFields.forEach((fields, i) => {
    test(`rejects malformed quote ${i}`, () => {
      expect(() => parseJupiterPrice({ ...valid, ...fields }, NOW)).toThrow();
    });
  });
  test("tiny prices retain precision; createdAt is not a price publication timestamp", () => {
    expect(
      parseJupiterPrice(
        { ...valid, usdPrice: 1.23e-12, createdAt: new Date(NOW).toISOString() },
        NOW,
      ),
    ).toEqual({
      priceUsd: 1.23e-12,
      sourceDecimals: 8,
      blockId: 100,
      priceTimestamp: null,
      fetchedAt: NOW / 1000,
    });
  });
  test("older pricing blocks cannot roll back a quote, even after rejection", async () => {
    const f = fixture();
    await f.service.getPrices([D.SOL]);
    f.advance(SPOT_POLL_MS);
    f.prices(() => Response.json({ [M.SOL]: { ...valid, blockId: 90 } }));
    expect((await f.service.getPrices([D.SOL])).prices[0]!.status).toBe("invalid");
    f.advance(SPOT_POLL_MS);
    expect((await f.service.getPrices([D.SOL])).prices[0]!.status).toBe("invalid");
  });
  test("old source block time stays stale despite a freshly fetched response", async () => {
    const f = fixture();
    f.rpc((rows) =>
      Response.json(rows.map((r) => ({ id: r.id, result: r.id === 0 ? MAIN : NOW / 1000 - 3600 }))),
    );
    const p = (await f.service.getPrices([D.SOL])).prices[0]!;
    expect(p.status).toBe("stale");
    expect(p.priceUsd).toBe(valid.usdPrice);
    expect(p.priceTimestamp).toBe(NOW / 1000 - 3600);
  });
  for (const mode of [
    "wrong-network",
    "null-time",
    "future-time",
    "duplicate-id",
    "rpc-error",
    "http-error",
  ]) {
    test(`timestamp ${mode} yields age-unverified, not a fabricated current time`, async () => {
      const f = fixture();
      f.rpc((rows) =>
        mode === "http-error"
          ? new Response("failed", { status: 429 })
          : Response.json(
              rows.map((r) => ({
                id: mode === "duplicate-id" ? 0 : r.id,
                ...(mode === "rpc-error"
                  ? { error: { code: -1 } }
                  : {
                      result:
                        r.id === 0
                          ? mode === "wrong-network"
                            ? DEV
                            : MAIN
                          : mode === "null-time"
                            ? null
                            : NOW / 1000 + 100,
                    }),
              })),
            ),
      );
      const p = (await f.service.getPrices([D.SOL])).prices[0]!;
      expect(p.status).toBe("age-unverified");
      expect(p.priceTimestamp).toBeNull();
      expect(p.priceUsd).toBe(valid.usdPrice);
    });
  }
  for (const status of [401, 403, 429, 500]) {
    test(`HTTP ${status} backs off globally, doesn't sign users out or zero a last-known price`, async () => {
      const f = fixture();
      await f.service.getPrices([D.SOL]);
      f.advance(SPOT_POLL_MS);
      f.prices(
        () =>
          new Response("never expose this response", { status, headers: { "retry-after": "120" } }),
      );
      const p = (await f.service.getPrices([D.SOL])).prices[0]!;
      expect(p.status).toBe([401, 403].includes(status) ? "restricted" : "unavailable");
      expect(p.priceUsd).toBe(valid.usdPrice);
      await f.service.getPrices([D.BTC]);
      expect(f.jupiterCalls()).toHaveLength(2);
      f.advance(status === 429 ? 120_000 : 60_000);
      f.prices((ids) => Response.json(Object.fromEntries(ids.map((id) => [id, valid]))));
      expect((await f.service.getPrices([D.BTC])).prices[0]!.status).toBe(
        status === 429 ? "stale" : "available",
      );
      expect(f.jupiterCalls()).toHaveLength(3);
    });
  }
  test("malformed/oversized/unexpected responses and transport failures fail closed", async () => {
    for (const bad of [
      () => new Response("{"),
      () => new Response(" ".repeat(262145)),
      () => Response.json([]),
      () => Response.json({ other: valid }),
      () => {
        throw new Error("credential=secret");
      },
    ]) {
      const f = fixture();
      f.prices(bad);
      const r = await f.service.getPrices([D.SOL]);
      expect(r.prices[0]!.status).toBe("unavailable");
      expect(JSON.stringify(r)).not.toContain("secret");
      expect(f.calls).toHaveLength(1);
    }
  });
  test("public route is GET-only, CORS-readable, no-store, and bounds input before fetching", async () => {
    const f = fixture(),
      app = new Hono();
    mountSpotPrices(app, f.service);
    for (const query of [
      "",
      "?mints=",
      "?mints=SOL",
      `?mints=${D.SOL}&mints=${D.BTC}`,
      `?mints=${Array(51).fill(D.SOL).join(",")}`,
    ]) {
      const r = await app.request("/v1/spot-prices" + query);
      expect(r.status).toBe(400);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(f.calls).toHaveLength(0);
    const response = await app.request(`/v1/spot-prices?mints=${D.SOL}`, {
      headers: { origin: "http://localhost:3001" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).source).toBe("jupiter");
    expect((await app.request(`/v1/spot-prices?mints=${D.SOL}`, { method: "POST" })).status).toBe(
      404,
    );
  });
});

describe("multi-issuer market reference prices", () => {
  test("one batch prices the quote and every issuer leg, with per-share prices", async () => {
    const f = fixture(MAIN);
    const app = new Hono();
    app.onError((e) => Response.json({ error: e.message }, { status: 404 }));
    const NVDAON = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
      NVDAR = "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu",
      market = mint(7);
    mountMarketSpotPrices(app, f.service, async (id) => {
      if (id !== market) throw new Error("Unknown indexed market");
      return {
        quoteMint: M.USDC,
        bases: [
          { collateral: 1, mint: M.NVDA, multiplierValue: 1.0017, tradable: true, halt: null },
          { collateral: 2, mint: NVDAON, multiplierValue: 1, tradable: true, halt: null },
          { collateral: 3, mint: NVDAR, multiplierValue: null, tradable: null, halt: null },
        ],
      };
    });
    const response = await app.request(`/v1/markets/${market}/spot-prices`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(f.jupiterCalls()).toHaveLength(1);
    expect(new URL(f.jupiterCalls()[0]!.url).searchParams.get("ids")!.split(",")).toHaveLength(4);
    expect(body.marketId).toBe(market);
    expect(body.quote).toMatchObject({ mint: M.USDC, status: "available" });
    expect(body.bases.map((b: { spot: { referenceSymbol: string } }) => b.spot.referenceSymbol)).toEqual([
      "NVDAx",
      "NVDAon",
      "NVDAr",
    ]);
    expect(body.bases[0].sharePriceUsd).toBeCloseTo(123.456 / 1.0017, 9);
    expect(body.bases[1].sharePriceUsd).toBe(123.456);
    // Unreadable issuer state never yields a per-share price.
    expect(body.bases[2].sharePriceUsd).toBeNull();
    expect((await app.request(`/v1/markets/${mint(8)}/spot-prices`)).status).toBe(404);
    expect((await app.request(`/v1/markets/not-a-key/spot-prices`)).status).toBe(400);
  });
});
