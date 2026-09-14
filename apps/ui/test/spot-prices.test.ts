import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEVNET_ASSET_MINTS as D,
  MAINNET_REFERENCE_MINTS as M,
  SOLANA_DEVNET_GENESIS as DEV,
  SOLANA_MAINNET_GENESIS as MAIN,
  expireSpotPrice,
  spotMapping,
  spotUsdValue,
  type SpotPrice,
  type SpotPricesResponse,
} from "@conditional-stocks/shared/spot-prices";
import {
  fetchSpotPrices,
  parseSpotPricesResponse,
  spotPricesUrl,
  withMarketSpotPrices,
} from "../src/services/spot-prices";
import { formatSpotUsd, SpotReference } from "../src/components/market/SpotReference";
import { previewOrder } from "../src/lib/trading/order";
import { assetsForMarkets } from "../src/hooks/useWalletAssets";
import { fixtureMarkets } from "./fixtures/protocol";

const NOW = Date.now(),
  at = Math.floor(NOW / 1000);
const price = (mint: string = D.SOL, changes: Partial<SpotPrice> = {}): SpotPrice => ({
  ...spotMapping(DEV, mint),
  priceUsd: 123.45,
  sourceDecimals: 9,
  blockId: 100,
  priceTimestamp: at - 5,
  fetchedAt: at,
  status: "available",
  ...changes,
});
const response = (prices = [price()]): SpotPricesResponse => ({
  source: "jupiter",
  sourceGenesisHash: MAIN,
  displayOnly: true,
  genesisHash: DEV,
  asOf: at,
  prices,
});

describe("display price validation", () => {
  test("strictly matches source, network, exact requested mint and devnet alias", () => {
    expect(parseSpotPricesResponse(response(), DEV, [D.SOL], NOW)).toEqual(response());
    const invalid: unknown[] = [
      null,
      {},
      [],
      { ...response(), source: "other" },
      { ...response(), sourceGenesisHash: DEV },
      { ...response(), genesisHash: MAIN },
      { ...response(), displayOnly: false },
      { ...response(), asOf: at + 30 },
      response([]),
      response([price(), price()]),
      response([price(D.BTC)]),
      response([price(D.SOL, { sourceMint: M.BTC })]),
      response([price(D.SOL, { testAsset: false })]),
      response([price(D.SOL, { valuationCompatible: false })]),
    ];
    for (const value of invalid)
      expect(() => parseSpotPricesResponse(value, DEV, [D.SOL], NOW)).toThrow();
  });
  test("rejects malformed numeric values, impossible quality and incomplete timestamps", () => {
    for (const patch of [
      { priceUsd: 0 },
      { priceUsd: Infinity },
      { priceUsd: NaN },
      { priceUsd: -1 },
      { priceUsd: "123" },
      { blockId: 0 },
      { blockId: 1.5 },
      { blockId: null },
      { sourceDecimals: 256 },
      { fetchedAt: at + 1 },
      { fetchedAt: null },
      { priceTimestamp: null },
      { priceTimestamp: at + 6 },
      { priceTimestamp: -1 },
      { status: "not-configured" },
      { status: "invalid" },
      { status: "unmapped" },
    ])
      expect(() =>
        parseSpotPricesResponse(
          response([{ ...price(), ...patch } as SpotPrice]),
          DEV,
          [D.SOL],
          NOW,
        ),
      ).toThrow();
  });
  test("any mainnet mint uses its own address, not a fixed symbol registry", () => {
    const mint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const body = {
      ...response(),
      genesisHash: MAIN,
      prices: [{ ...price(), ...spotMapping(MAIN, mint) }],
    };
    expect(parseSpotPricesResponse(body, MAIN, [mint], NOW).prices[0]!.sourceMint).toBe(mint);
  });
  test("unmapped mints and missing prices are explicit, never a fake $1", () => {
    const mint = "11111111111111111111111111111111";
    const p: SpotPrice = {
      ...spotMapping(DEV, mint),
      status: "unmapped",
      priceUsd: null,
      blockId: null,
      sourceDecimals: null,
      fetchedAt: null,
      priceTimestamp: null,
    };
    expect(parseSpotPricesResponse(response([p]), DEV, [mint], NOW).prices[0]).toEqual(p);
    expect(spotUsdValue(p, NOW)).toBeNull();
  });
  test("source age, cache age, tab resume and clock rollback expire independently", () => {
    expect(expireSpotPrice(price(), NOW).status).toBe("available");
    expect(expireSpotPrice(price(), NOW + 61_000).status).toBe("stale");
    expect(expireSpotPrice(price(D.SOL, { priceTimestamp: at - 121 }), NOW).status).toBe("stale");
    expect(expireSpotPrice(price(), NOW - 10_000).status).toBe("stale");
    expect(expireSpotPrice(price(D.SOL, { priceTimestamp: null }), NOW).status).toBe(
      "age-unverified",
    );
    expect(spotUsdValue(price(D.SOL, { priceTimestamp: null }), NOW)).toBeNull();
    expect(spotUsdValue(price(D.TSLA), NOW)).toBeNull(); // no unreviewed scaled-unit valuation
  });
  test("transport is direct, credential-free and abortable; errors don't expose upstream text", async () => {
    const original = globalThis.fetch;
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), ...(init ? { init } : {}) });
      return Response.json(response());
    }) as typeof fetch;
    try {
      await fetchSpotPrices(DEV, [D.SOL], { base: "https://api.example" });
      expect(seen[0]!.url).toStartWith("https://api.example/v1/spot-prices?mints=");
      expect(seen[0]!.init?.credentials).toBe("omit");
      expect(seen[0]!.init?.redirect).toBe("error");
      expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(seen[0]!.init?.headers).has("authorization")).toBe(false);
      expect(new Headers(seen[0]!.init?.headers).has("x-api-key")).toBe(false);
      globalThis.fetch = (async () =>
        new Response("secret upstream message", { status: 401 })) as unknown as typeof fetch;
      await expect(fetchSpotPrices(DEV, [D.SOL])).rejects.toThrow("Spot prices unavailable (401)");
    } finally {
      globalThis.fetch = original;
    }
  });
  test("URLs permit HTTPS/loopback only and reject credentials, path injection and invalid mints", () => {
    for (const base of [
      "https://user:secret@api.example",
      "http://api.example",
      "https://api.example/path",
      "https://api.example/?key=secret",
      "https://api.example/#hash",
      "bad",
    ])
      expect(() => spotPricesUrl([D.SOL], base)).toThrow();
    for (const mints of [[], ["SOL"], Array(51).fill(D.SOL)])
      expect(() => spotPricesUrl(mints)).toThrow();
    expect(spotPricesUrl([D.SOL], "http://127.0.0.1:3000")).toStartWith(
      "http://127.0.0.1:3000/v1/spot-prices",
    );
    expect(new URL(spotPricesUrl([D.SOL, D.SOL])).searchParams.get("mints")).toBe(D.SOL);
  });
});

describe("UI and trading separation", () => {
  const market = { ...fixtureMarkets[0]!, baseToken: D.SOL, quoteToken: D.USDC };
  test("refresh modifies only display fields; books, precision and order arithmetic are unchanged", () => {
    const before = previewOrder("1", "123.45", market);
    const [updated] = withMarketSpotPrices(
      [market],
      response([price(), price(D.USDC, { priceUsd: 0.998 })]),
      NOW,
    );
    expect(updated!.ordinaryReference).toBe(123.45);
    expect(updated!.quoteSpotReference!.priceUsd).toBe(0.998);
    expect(updated!.yes).toBe(market.yes);
    expect(updated!.no).toBe(market.no);
    expect(previewOrder("1", "123.45", updated!)).toEqual(before);
    const [down] = withMarketSpotPrices([updated!], undefined, NOW, true);
    expect(down!.ordinaryReference).toBeNull();
    expect(down!.spotReference!.status).toBe("unavailable");
    expect(previewOrder("1", "123.45", down!)).toEqual(before);
    expect(withMarketSpotPrices([market], undefined, NOW)[0]!.ordinaryReference).toBeNull();
  });
  test("portfolio estimates use actual USDC price, never assume peg or stale/scaled prices", () => {
    const [updated] = withMarketSpotPrices(
      [market],
      response([price(), price(D.USDC, { priceUsd: 0.998 })]),
      NOW,
    );
    const assets = assetsForMarkets([updated!]);
    expect(assets.find((a) => a.token === D.USDC)!.reference).toBe(0.998);
    expect(assets.find((a) => a.token === D.SOL)!.reference).toBe(123.45);
    const [stale] = withMarketSpotPrices([updated!], undefined, NOW + 121_000);
    expect(assetsForMarkets([stale!]).every((a) => a.reference === null)).toBe(true);
  });
  test("UI stays minimal and unbranded while warning about stale or unknown prices", () => {
    const render = (p?: SpotPrice) =>
      renderToStaticMarkup(createElement(SpotReference, { price: p }));
    const live = render(price(D.NVDA));
    expect(live).not.toMatch(/jupiter/i);
    expect(live).not.toContain("NVDAx");
    expect(live).toContain("devnet test token");
    expect(live).not.toContain("Mainnet pricing slot");
    expect(live).not.toContain("Recent price");
    expect(live).not.toContain("<p");
    expect(live).toContain("Spot reference · USD");
    expect(live).not.toContain("Live");
    expect(render(price(D.SOL, { status: "stale" }))).toContain("last known");
    expect(render(price(D.SOL, { status: "age-unverified", priceTimestamp: null }))).toContain(
      "Price age unverified",
    );
    expect(render()).toContain("Price unavailable");
    for (const status of [
      "available",
      "stale",
      "age-unverified",
      "restricted",
      "unavailable",
    ] as const)
      expect(render(price(D.SOL, { status }))).not.toMatch(/jupiter/i);
    expect(formatSpotUsd(1.23e-12)).not.toBe("$0.00");
  });
});
