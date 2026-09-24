import { expect, test } from "bun:test";
import { parsePriceRawX18, parseShareAmount } from "@conditional-stocks/domain";
import { groupMarkets, sortEventGroups } from "../src/lib/markets/presentation";
import { aggregateBook, marketsApi } from "../src/services/markets-api-service";
import { fixtureMarkets } from "./fixtures/protocol";

test("catalogue reads all books in one indexed batch and keeps one-sided executable prices", async () => {
  const originalFetch = globalThis.fetch;
  const markets = [fixtureMarkets[0]!, { ...fixtureMarkets[0]!, id: "second-market" }].map(
    (m, index) => ({
      ...m,
      createdAt: new Date(Date.UTC(2026, 8, 14 + index)).toISOString(),
    }),
  );
  const paths: string[] = [];
  const orderbookView = { value: null as string | null };
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname;
      paths.push(path);
      if (path === "/markets")
        return Response.json({ markets: markets.map((m) => ({ ...m, state: 2 })) });
      if (path === "/orderbooks") {
        orderbookView.value = url.searchParams.get("view");
        return Response.json({
          books: Object.fromEntries(
            markets.map((m) => [
              m.id,
              {
                truncated: false,
                orders: [
                  {
                    branch: 0,
                    side: 1,
                    limitPriceRawX18: String(parsePriceRawX18("254.35", m)),
                    remaining: String(parseShareAmount("1", m)),
                    byBases: { "2": String(parseShareAmount("1", m)) },
                  },
                ],
              },
            ]),
          ),
        });
      }
      if (path.endsWith("/polymarket"))
        return Response.json({
          metadata: {
            fetchedAtMs: String(Date.UTC(2026, 8, 14)),
            rawPayload: {
              outcomes: '["Yes","No"]',
              outcomePrices: '["0.42","0.58"]',
            },
          },
        });
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const read = await marketsApi.liveMarkets();
    expect(read).toHaveLength(2);
    expect(read.every((m) => m.bookQuality === "available" && m.yes.bestAsk === 254.35)).toBe(true);
    expect(read.map((m) => m.createdAt)).toEqual(markets.map((m) => m.createdAt));
    expect(paths.filter((path) => path === "/orderbooks")).toHaveLength(1);
    expect(orderbookView.value).toBe("levels");
    expect(paths.filter((path) => path.endsWith("/polymarket"))).toHaveLength(1);
    expect(paths.some((path) => path.startsWith("/orderbook/"))).toBe(false);
    expect(read.every((market) => market.probability.value === 0.42)).toBe(true);
    const [first] = read;
    expect(first?.bases.map((leg) => leg.collateral)).toEqual([1, 2, 3]);
    expect(first?.bases[0]?.live?.multiplierValue).toBe(1.0017);
    expect(first?.bases[2]?.live?.halt).toBe("issuer-paused");
    expect(first?.claimMints).toHaveLength(12);
    expect(first?.yes.asks[0]?.byBases).toEqual([{ mask: 2, quantity: 1, quantityRaw: "1000000" }]);
    // Unknown issuer mints fall back to synthetic leg labels and a mint-set asset key.
    expect(first?.bases.map((leg) => leg.symbol)).toEqual(["STOCK·1", "STOCK·2", "STOCK·3"]);
    expect(first?.assetKey.startsWith("mints:")).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalogue starts the compact books request without waiting for the markets response", async () => {
  const originalFetch = globalThis.fetch;
  let releaseMarkets: ((response: Response) => void) | undefined;
  let booksStarted = false;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/markets")
        return new Promise<Response>((resolve) => {
          releaseMarkets = resolve;
        });
      if (url.pathname === "/orderbooks") {
        booksStarted = true;
        return Response.json({ books: {} });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch;
    const read = marketsApi.liveMarkets();
    await Promise.resolve();
    expect(booksStarted).toBe(true);
    expect(releaseMarkets).toBeDefined();
    releaseMarkets?.(Response.json({ markets: [] }));
    expect(await read).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("event ordering is newest-first by actual creation time and stable through depth changes", () => {
  const a = { ...fixtureMarkets[0]!, createdAt: "2026-09-14T10:00:00.000Z" };
  const b = {
    ...fixtureMarkets[0]!,
    id: "older-market",
    mapping: { ...fixtureMarkets[0]!.mapping, conditionId: "older-condition" },
    createdAt: "2026-09-13T10:00:00.000Z",
  };
  const first = sortEventGroups(groupMarkets([b, a]), "newest");
  expect(first.map((g) => g[0]?.id)).toEqual([a.id, b.id]);
  const deeper = { ...b, yes: { ...b.yes, depthUsd: 1_000_000 } };
  expect(sortEventGroups(groupMarkets([a, deeper]), "newest").map((g) => g[0]?.id)).toEqual([
    a.id,
    b.id,
  ]);
  expect(sortEventGroups(groupMarkets([a, b]), "oldest").map((g) => g[0]?.id)).toEqual([
    b.id,
    a.id,
  ]);
});

const v3Market = () => {
  const m = fixtureMarkets[0]!;
  return { ...m, state: 2 };
};
async function readOne(market: unknown) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/markets") return Response.json({ markets: [market] });
      if (url.pathname === "/orderbooks") return Response.json({ books: {} });
      if (url.pathname.endsWith("/polymarket")) return Response.json({});
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch;
    return await marketsApi.liveMarkets();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("v3 markets require share units, a 12-mint asset table and ordered issuer legs", async () => {
  expect(await readOne(v3Market())).toHaveLength(1);
  const bad = [
    { ...v3Market(), protocolVersion: 2 },
    { ...v3Market(), priceFormat: "raw-unit-ratio-x18" },
    { ...v3Market(), claimMints: v3Market().claimMints.slice(0, 6) },
    { ...v3Market(), bases: [...v3Market().bases].reverse() },
    { ...v3Market(), bases: [{ ...v3Market().bases[0]!, mint: v3Market().bases[1]!.mint }] },
    { ...v3Market(), bases: [{ ...v3Market().bases[0]!, scale: "1000" }] },
    { ...v3Market(), quoteClaimMints: { yes: "x", no: "y" } },
    {
      ...v3Market(),
      bases: [{ ...v3Market().bases[0]!, live: { ...v3Market().bases[0]!.live, tradable: false } }],
    },
  ];
  for (const market of bad) await expect(readOne(market)).rejects.toThrow();
  // A freshly created market lists the quote only until its first issuer is added.
  const [empty] = await readOne({ ...v3Market(), bases: [] });
  expect(empty?.bases).toEqual([]);
  expect(empty?.assetKey).toBe(`market:${v3Market().id}`);
});

test("known issuer mints resolve symbols, issuers and one NVDA asset key", async () => {
  const m = v3Market();
  const real = [
    "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
    "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu",
  ];
  const claimMints = [...m.claimMints];
  real.forEach((mint, i) => {
    claimMints[3 * (i + 1)] = mint;
  });
  const [read] = await readOne({
    ...m,
    claimMints,
    bases: m.bases.map((leg, i) => ({ ...leg, mint: real[i] })),
  });
  expect(read?.ticker).toBe("NVDA");
  expect(read?.assetKey).toBe("asset:NVDA");
  expect(read?.bases.map((leg) => leg.symbol)).toEqual(["NVDAx", "NVDAon", "NVDAr"]);
  expect(read?.bases.map((leg) => leg.issuer)).toEqual([
    "xStocks",
    "Ondo Global Markets",
    "Remora",
  ]);
  expect(read?.assetMetadata?.name).toBe("NVIDIA");
});

test("depth aggregates byBases levels and full orders by issuer mask in share units", () => {
  const m = fixtureMarkets[0]!;
  const price = String(parsePriceRawX18("10", m));
  const book = aggregateBook(
    [
      {
        branch: 0,
        side: 1,
        limitPriceRawX18: price,
        remaining: "3000000",
        byBases: { "1": "1000000", "2": "2000000" },
      },
      { branch: 0, side: 1, limitPriceRawX18: price, remaining: "500000", bases: 2 },
      {
        branch: 0,
        side: 0,
        limitPriceRawX18: String(parsePriceRawX18("9", m)),
        remaining: "4000000",
        bases: 7,
      },
      { branch: 1, side: 0, limitPriceRawX18: price, remaining: "1", bases: 1 },
    ],
    0,
    m,
  );
  expect(book.asks).toHaveLength(1);
  expect(book.asks[0]?.quantity).toBe(3.5);
  expect(book.asks[0]?.byBases).toEqual([
    { mask: 1, quantity: 1, quantityRaw: "1000000" },
    { mask: 2, quantity: 2.5, quantityRaw: "2500000" },
  ]);
  expect(book.bids[0]?.byBases).toEqual([{ mask: 7, quantity: 4, quantityRaw: "4000000" }]);
  expect(book.bestAskExact).toBe("10");
  // A level mixing an unknown breakdown cannot claim a per-issuer split.
  const mixed = aggregateBook(
    [
      { branch: 0, side: 1, limitPriceRawX18: price, remaining: "1000000", bases: 1 },
      { branch: 0, side: 1, limitPriceRawX18: price, remaining: "1000000" },
    ],
    0,
    m,
  );
  expect(mixed.asks[0]?.byBases).toBeUndefined();
  expect(mixed.asks[0]?.quantity).toBe(2);
});
