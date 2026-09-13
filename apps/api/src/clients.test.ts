import { expect, test } from "bun:test";
import { parseOrder, type ValidationSnapshot } from "@conditional-stocks/gateway";
import type { Hex } from "viem";
import { IndexerClient } from "./chain.ts";
import { PolymarketIngestorClient } from "./polymarket-client.ts";

const hash: Hex = `0x${"11".repeat(32)}`;

test("candidate transport binds chain/exchange/block hash and rejects malformed or unbounded rows", async () => {
  const exchange = "0x1000000000000000000000000000000000000001";
  const order = parseOrder({
    maker: exchange,
    recipient: exchange,
    marketId: hash,
    side: 0,
    branch: 0,
    fundingKind: 0,
    quantity: "1000000000000000000",
    tif: 0,
    limitPriceRawX18: "200000000",
    expiry: "2000",
    nonce: "0",
    salt: hash,
    maxFeeBps: 0,
  });
  const snapshot = {
    chainId: 31337n,
    safeBlockNumber: 100n,
    safeBlockHash: hash,
  } as ValidationSnapshot;
  const row = {
    order: { ...order, side: 1 },
    orderHash: hash,
    remaining: "1000000000000000000",
    sequence: "1",
  };
  const good = { chainId: 31337, exchange, blockNumber: "100", blockHash: hash, candidates: [row] };
  let body: unknown = good;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const query = new URL(request.url).searchParams;
      expect(query.get("timestamp")).toBe("1501");
      expect(query.get("side")).toBe("1");
      return new Response(
        JSON.stringify(body, (_, v) => (typeof v === "bigint" ? String(v) : v)),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const client = new IndexerClient(server.url.href.replace(/\/$/, ""));
  const read = () => client.matchCandidates(order, snapshot, 0, exchange, 1501n);
  try {
    expect(await read()).toMatchObject([{ remaining: 10n ** 18n, sequence: 1n }]);
    for (const patch of [
      { chainId: 1 },
      { exchange: undefined },
      { blockHash: "0x" },
      { blockNumber: "101" },
      { candidates: null },
      { candidates: Array(34).fill(row) },
      { candidates: [null] },
      { candidates: [{ ...row, remaining: 1e18 }] },
      { candidates: [{ ...row, sequence: "1e3" }] },
      { candidates: [{ ...row, orderHash: "0x" }] },
    ]) {
      body = { ...good, ...patch };
      await expect(read()).rejects.toMatchObject({ status: 503 });
    }
    body = null;
    await expect(read()).rejects.toMatchObject({ status: 503 });
  } finally {
    await server.stop(true);
  }
});
test("indexer HTTP reads distinguish missing, unhealthy, unavailable and successful responses", async () => {
  let status = 200;
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push(new URL(request.url).pathname);
      return Response.json({ healthy: true, id: hash }, { status });
    },
  });
  const client = new IndexerClient(server.url.href.replace(/\/$/, ""));
  try {
    const readers = [
      () => client.order(hash),
      () => client.market(hash),
      () => client.resolution(hash),
      () => client.transaction(hash),
    ];
    for (const read of readers) {
      status = 200;
      expect(await read()).toMatchObject({ id: hash });
      status = 404;
      expect(await read()).toBeNull();
      status = 503;
      await expect(read()).rejects.toThrow("request failed");
    }
    await expect(client.health()).rejects.toMatchObject({ status: 503 });
    status = 200;
    expect((await client.health()).healthy).toBe(true);
    expect(calls).toContain(`/orders/${hash}`);
  } finally {
    await server.stop(true);
  }
  await expect(client.health()).rejects.toMatchObject({ status: 503 });
});

test("ingestor HTTP client sends credentials only on internal routes and preserves error classifications", async () => {
  let status = 200;
  let response: unknown = { snapshotId: "snapshot" };
  const calls: { path: string; auth: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.json() : null,
      });
      return Response.json(response, { status });
    },
  });
  const client = new PolymarketIngestorClient(server.url.href.replace(/\/$/, ""), "test-token");
  try {
    expect((await client.fetchMetadata("42")).snapshotId).toBe("snapshot");
    await client.track("snapshot");
    await client.snapshot("snapshot/id");
    await client.probability(hash);
    await client.metadata(hash);
    expect(calls.slice(0, 3).every((call) => call.auth === "Bearer test-token")).toBe(true);
    expect(calls.slice(3).every((call) => call.auth === null)).toBe(true);
    expect(calls[0]?.body).toEqual({ gammaMarketId: "42" });
    expect(calls[2]?.path).toContain("snapshot%2Fid");
    status = 409;
    response = { error: { message: "mapping changed" } };
    await expect(client.track("snapshot")).rejects.toMatchObject({
      status: 409,
      message: "mapping changed",
    });
    status = 502;
    response = {};
    await expect(client.metadata(hash)).rejects.toMatchObject({
      status: 503,
      message: "ingestor returned 502",
    });
  } finally {
    await server.stop(true);
  }
  await expect(client.fetchMetadata("42")).rejects.toMatchObject({
    status: 503,
    code: "POLYMARKET_INGESTOR_UNAVAILABLE",
  });
  await expect(client.probability(hash)).rejects.toMatchObject({ status: 503 });
});
