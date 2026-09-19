import { expect, test } from "bun:test";
import { parsePriceRawX18, parseTokenAmount } from "@conditional-stocks/domain";
import { groupMarkets, sortEventGroups } from "../src/lib/markets/presentation";
import { marketsApi } from "../src/services/markets-api-service";
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
                    remaining: String(parseTokenAmount("1", m.baseTokenDecimals)),
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
