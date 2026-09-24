import { expect, test } from "bun:test";
import { marketsApi } from "../src/services/markets-api-service";
import { fixtureMarkets } from "./fixtures/protocol";

test("market reads include saved artwork, including legacy raw snapshots, without extra requests", async () => {
  const originalFetch = globalThis.fetch;
  const image = "https://polymarket-upload.s3.us-east-2.amazonaws.com/event.png";
  let replicaReads = 0;
  try {
    for (const [metadata, expected] of [
      [{ normalized: { imageUrl: image } }, image],
      [{ normalized: {}, rawPayload: { image } }, image],
      [{ normalized: {}, rawPayload: { icon: image } }, image],
      [{ normalized: {}, rawPayload: { image: "javascript:alert(1)" } }, null],
      [{ normalized: {} }, null],
    ] as const) {
      const paths: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === "/v1/tokens/replicas") {
          replicaReads++;
          return Response.json({ replicas: {} });
        }
        paths.push(path);
        if (path === "/markets")
          return Response.json({ markets: [{ ...fixtureMarkets[0], state: 2 }] });
        if (path.endsWith("/polymarket")) return Response.json({ metadata });
        if (path === "/orderbooks") return Response.json({ books: {} });
        if (path.startsWith("/orderbook/")) return Response.json({ orders: [] });
        throw new Error(`Unexpected request: ${path}`);
      }) as typeof fetch;
      const markets = await marketsApi.liveMarkets();
      expect(markets[0]?.imageUrl).toBe(expected);
      expect(paths).toHaveLength(3);
    }
    // The deployment's replica mapping is read once and reused across reads.
    expect(replicaReads).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
