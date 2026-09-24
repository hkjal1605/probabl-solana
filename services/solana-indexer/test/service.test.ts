import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Keypair } from "@solana/web3.js";
import { BN, PublicKey, SolanaClient, bn, coder, encodeAccount } from "@conditional-stocks/solana-client";
import idl from "../../../packages/solana-client/src/idl.json";
import type { CommitNotice, IndexedTransaction } from "../src/live/index.ts";
import { transactionResponse } from "../src/live/geyser.ts";
import type { Snapshot } from "../src/projection.ts";
import { IndexerService, type LiveSource, type ServiceDependencies } from "../src/service.ts";
import { liveFixture, orderFixture } from "./live-fixture.ts";

const f = liveFixture(2);
const client = new SolanaClient({
  rpcUrl: "http://127.0.0.1:8899",
  config: f.config.toBase58(),
  genesisHash: Keypair.generate().publicKey.toBase58(),
});
const program = client.program.toBase58();

function eventLine(name: string, value: Record<string, unknown>) {
  const discriminator = Buffer.from(idl.events.find((e) => e.name === name)!.discriminator);
  return `Program data: ${Buffer.concat([discriminator, coder.types.encode(name, value)]).toString("base64")}`;
}
const trade = (market: PublicKey, quantity: number) =>
  eventLine("Trade", {
    market,
    taker: f.owner,
    maker: f.other,
    branch: 0,
    base: 1,
    quantity: new BN(quantity),
    base_amount: new BN(quantity),
    price: new BN(10).pow(new BN(17)),
    quote: new BN(quantity),
    buyer_fee: new BN(0),
    seller_fee: new BN(0),
  });
function tx(slot: number, signature: string, events: string[], err: unknown = undefined, logs?: string[]): IndexedTransaction {
  return {
    signature,
    slot,
    blockTime: 1_700_000_000 + slot,
    response: transactionResponse(
      {
        transaction: { message: { accountKeys: [], instructions: [] } },
        meta: {
          err,
          logMessages: logs ?? [`Program ${program} invoke [1]`, ...events, `Program ${program} success`],
          logMessagesNone: false,
          loadedWritableAddresses: [],
          loadedReadonlyAddresses: [],
        },
      },
      slot,
    ),
  };
}

function fakeLive(s: Snapshot) {
  const live = {
    started: 0,
    healthy: true,
    confirmedSnapshot: s,
    finalizedSnapshot: s,
    start: async () => {
      live.started++;
    },
    stop: () => {},
    confirmed: () => live.confirmedSnapshot,
    finalized: () => live.finalizedSnapshot,
    health: () => ({ healthy: live.healthy, confirmedSlot: live.confirmedSnapshot.slot, finalizedSlot: live.finalizedSnapshot.slot, lastMessageAgeMs: 3 }),
    rawAccounts: () => [{ address: "a", data: "AA==" }],
    refreshLegs: () => {},
  };
  return live satisfies LiveSource;
}

function harness(options: { persistIntervalMs?: number; auditIntervalMs?: number; tradeTail?: number } = {}) {
  const s: Snapshot = { ...f.s, slot: 100 };
  const live = fakeLive(s);
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string) => (...args: unknown[]) => calls.push({ name, args });
  const db = {
    creationEvents: async (...args: unknown[]) => {
      record("creationEvents")(...args);
      return [{ market: f.marketId, block_time: "1700000000" }];
    },
    retiredEvents: async (...args: unknown[]) => {
      record("retiredEvents")(...args);
      return db.retired;
    },
    retired: [] as { data: Record<string, unknown> }[],
    legEvents: async () => [{ signature: "leg", event_index: 0, block_time: "1", data: { kind: 15, amount: "1", asset: 3 } }],
    trades: async (...args: unknown[]) => {
      record("trades")(...args);
      return db.tradeRows;
    },
    tradeRows: [] as Record<string, unknown>[],
    resolutionEvent: async () => db.resolution,
    resolution: null as null | { signature: string; data: Record<string, unknown> },
    lookupTables: async () => ["table"],
    failSnapshot: async (...args: unknown[]) => record("failSnapshot")(...args),
  };
  const deps = {
    failPersist: undefined as Error | undefined,
    staleSnapshot: false,
    replayHistory: async (...args: unknown[]) => {
      record("replayHistory")(args[3]);
      return 0;
    },
    persistStreamedHistory: async (...args: unknown[]) => {
      record("persistStreamedHistory")(args[3], (args[5] as IndexedTransaction[]).map((t) => t.signature));
      if (deps.failPersist) throw deps.failPersist;
      return 0;
    },
    reconcileVaults: async (_client: unknown, snapshot: Snapshot) => {
      record("reconcileVaults")(snapshot.slot);
      return { slot: snapshot.slot, ok: true } as never;
    },
    persistSnapshot: async (_db: unknown, _domain: string, image: Snapshot) => {
      record("persistSnapshot")(image.slot, image.rawAccounts, image.createdAt?.size);
      return !deps.staleSnapshot;
    },
  };
  const service = new IndexerService(client, db as never, "domain", live, {
    ...options,
    dependencies: deps as unknown as Partial<ServiceDependencies>,
  });
  const published: unknown[] = [];
  service.stream.publish = (value) => published.push(value);
  const owners: string[][] = [];
  (service as unknown as { wallets: unknown }).wallets = {
    get: async (owner: string) => ({ owner, balances: { [f.quote.toBase58()]: { amount: "7" } } }),
    refresh: async () => {},
    refreshOwners: async (list: string[]) => owners.push(list),
    touch: () => {},
    peek: () => undefined,
  };
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, 503));
  service.mount(app);
  const get = async (path: string) => {
    const response = await app.request(path);
    return { status: response.status, body: (await response.json()) as any };
  };
  return { s, live, db, deps, service, calls, published, owners, app, get };
}

const notice = (
  commitment: "confirmed" | "finalized",
  snapshot: Snapshot,
  transactions: IndexedTransaction[] = [],
  changed: string[] = [],
  previous = snapshot,
): CommitNotice => ({ commitment, slot: snapshot.slot, snapshot, previous, changed: new Set(changed), rebuilt: false, transactions });

describe("indexer service", () => {
  test("start backfills finalized history to the stream base and persists it", async () => {
    const h = harness();
    expect(() => h.service.custody()).toThrow("still being indexed");
    await h.service.start();
    expect(h.live.started).toBe(1);
    expect(h.service.historyReady).toBe(true);
    expect(h.calls.map((c) => c.name)).toEqual(["replayHistory", "creationEvents", "retiredEvents", "reconcileVaults", "persistSnapshot"]);
    expect(h.calls[0]!.args).toEqual([100]);
    expect(h.calls.at(-1)!.args).toEqual([100, [{ address: "a", data: "AA==" }], 1]);
    expect(h.service.custody().createdAt!.get(f.marketId)).toBeDefined();
    expect(h.service.trading().createdAt!.size).toBe(1);
  });

  test("confirmed commits publish trades and retired orders immediately", async () => {
    const h = harness({ tradeTail: 2 });
    await h.service.start();
    const market = new PublicKey(f.marketId);
    const foreign = PublicKey.unique();
    const [retiredId, open] = orderFixture(f.marketId, f.other, client.program, { salt: 5 });
    const retiredOrder = { ...open, status: 2, remaining: bn(0) };
    const retired = eventLine("OrderRetired", { market, account: new PublicKey(retiredId), data: encodeAccount("Order", retiredOrder) });
    const invalid = eventLine("OrderRetired", { market, account: new PublicKey(retiredId), data: encodeAccount("Order", open) });
    const s = { ...h.s, slot: 101 };
    h.service.onCommit(
      notice("confirmed", s, [
        tx(101, "t1", [trade(market, 1), retired, invalid]),
        tx(101, "failed", [trade(market, 9)], { err: 1 }),
        tx(101, "truncated", [], undefined, [`Program ${program} invoke [1]`, "Log truncated"]),
        tx(101, "foreign", [trade(foreign, 9)]),
        tx(101, "t2", [trade(market, 2)]),
        tx(101, "t3", [trade(market, 3)]),
      ], [f.orderId]),
    );
    // Bounded tail, newest first; failed, malformed and foreign events are skipped.
    expect(h.service.confirmedTail(new Set([f.marketId])).map((t) => t.signature)).toEqual(["t3", "t2"]);
    expect(h.service.confirmedTail(new Set(["other"]))).toEqual([]);
    expect(h.published.length).toBe(1);
    const orders = await h.get("/orders");
    expect(orders.body.orders.map((o: { id: string }) => o.id).sort()).toEqual([f.orderId, retiredId].sort());
    expect(orders.body.orders.every((o: { confirmation: string }) => o.confirmation === "confirmed")).toBe(true);
  });

  test("finalized commits persist history in order, coalesced, and prune the confirmed tail", async () => {
    const h = harness({ persistIntervalMs: 60_000, auditIntervalMs: 60_000 });
    const market = new PublicKey(f.marketId);
    // Finalized notices before history is ready are queued, not processed.
    const early = { ...h.s, slot: 101 };
    h.service.onCommit(notice("finalized", early, [tx(101, "f1", [trade(market, 1)])]));
    await h.service.start();
    await h.service.drain();
    h.service.onCommit(notice("confirmed", { ...h.s, slot: 103 }, [tx(102, "c2", [trade(market, 2)]), tx(103, "c3", [trade(market, 3)])]));
    const a = { ...h.s, slot: 102 },
      b = { ...h.s, slot: 103 };
    h.calls.length = 0;
    h.service.onCommit(notice("finalized", a, [tx(102, "c2", [trade(market, 2)])], [f.orderId]));
    h.service.onCommit(notice("finalized", b, [], [[...h.s.pools.keys()][0]!]));
    await h.service.drain();
    const streamed = h.calls.filter((c) => c.name === "persistStreamedHistory");
    // f1 drained right after start; c2 is its own pass; the pool change coalesces after it.
    expect(streamed.map((c) => c.args)).toEqual([
      [102, ["c2"]],
      [103, []],
    ]);
    expect(h.service.confirmedTail(new Set([f.marketId]))).toEqual([]);
    // Pool changes force a vault audit; persistence is throttled.
    expect(h.calls.filter((c) => c.name === "reconcileVaults").map((c) => c.args[0])).toEqual([103]);
    expect(h.calls.filter((c) => c.name === "persistSnapshot")).toEqual([]);
    expect(h.owners.flat()).toContain(f.owner.toBase58());
    expect(h.service.persistError).toBeNull();
  });

  test("failures mark custody reads unavailable and re-derive history from RPC", async () => {
    const h = harness({ persistIntervalMs: 0 });
    await h.service.start();
    h.deps.failPersist = new Error("db down");
    h.service.onCommit(notice("finalized", { ...h.s, slot: 101 }));
    await h.service.drain();
    expect(h.service.persistError).toBe("db down");
    expect(h.calls.some((c) => c.name === "failSnapshot" && c.args[1] === 101)).toBe(true);
    expect(() => h.service.custody()).toThrow("persistence failed: db down");
    expect((await h.get("/payouts/" + f.owner.toBase58())).status).toBe(503);
    // The next pass replays from RPC instead of trusting the stream.
    h.deps.failPersist = undefined;
    h.calls.length = 0;
    h.service.onCommit(notice("finalized", { ...h.s, slot: 102 }));
    await h.service.drain();
    expect(h.calls[0]).toEqual({ name: "replayHistory", args: [102] });
    expect(h.service.persistError).toBeNull();
    // A stream resync does the same.
    h.service.onResync();
    h.calls.length = 0;
    h.service.onCommit(notice("finalized", { ...h.s, slot: 103 }));
    await h.service.drain();
    expect(h.calls[0]!.name).toBe("replayHistory");
    // A concurrent newer snapshot is an error, not a silent overwrite.
    h.deps.staleSnapshot = true;
    h.service.onCommit(notice("finalized", { ...h.s, slot: 104 }));
    await h.service.drain();
    expect(h.service.persistError).toContain("newer indexer snapshot");
    // An unhealthy stream closes trading and custody reads.
    h.live.healthy = false;
    expect(() => h.service.trading()).toThrow("stream unavailable");
    expect(() => h.service.custody()).toThrow("stream unavailable");
  });
});

describe("indexer routes", () => {
  test("trading routes serve the confirmed view", async () => {
    const h = harness();
    await h.service.start();
    const health = await h.get("/health");
    expect(health.body).toMatchObject({ healthy: true, head: { confirmedBlock: "100", finalizedBlock: "100" }, streamLagMs: 3, slot: "100" });
    const markets = await h.get("/markets");
    expect(markets.body.confirmation).toBe("confirmed");
    expect(markets.body.markets.length).toBe(2);
    expect((await h.get("/markets/" + f.marketId)).body.id).toBe(f.marketId);
    expect((await h.get("/markets/unknown")).status).toBe(404);
    expect((await h.get("/orders?maker=" + f.owner.toBase58() + "&status=open")).body.orders.length).toBe(1);
    expect((await h.get("/orders?maker=" + f.other.toBase58())).body.orders.length).toBe(0);
    expect((await h.get("/orderbook/" + f.marketId)).body.orders.map((o: { id: string }) => o.id)).toEqual([f.orderId]);
    const books = (await h.get("/orderbooks")).body.books;
    expect(books[f.marketId].orders.length).toBe(1);
    expect(Object.keys(books).length).toBe(2);
    const levels = (await h.get("/orderbooks?view=levels")).body;
    expect(levels.slot).toBe("100");
    expect(levels.books.length ?? Object.keys(levels.books).length).toBeGreaterThan(0);
    expect((await h.get("/lookup-tables")).body).toEqual({ tables: ["table"] });
    h.live.healthy = false;
    expect((await h.get("/markets")).status).toBe(503);
  });

  test("custody routes serve the finalized view", async () => {
    const h = harness();
    expect((await h.get("/reconciliation")).status).toBe(503);
    await h.service.start();
    expect((await h.get("/reconciliation")).body).toEqual({ slot: 100, ok: true });
    h.service.reconciliation = undefined;
    expect((await h.get("/reconciliation")).body.error).toContain("not available");
    expect((await h.get(`/markets/${f.marketId}/leg-events`)).body.events.length).toBe(1);
    expect((await h.get("/markets/unknown/leg-events")).status).toBe(404);
    const owner = f.owner.toBase58();
    expect((await h.get("/positions/" + owner)).body.owner).toBe(owner);
    expect((await h.get(`/balances/${owner}?token=${f.quote.toBase58()}`)).body).toEqual({ amount: "7" });
    expect((await h.get(`/balances/${owner}?token=${PublicKey.unique().toBase58()}`)).status).toBe(404);
    const payouts = (await h.get("/payouts/" + owner)).body;
    expect(payouts.vault).toBe(program);
    // Resolutions: only resolved markets with an indexed resolution transaction.
    expect((await h.get("/resolutions/" + f.marketId)).status).toBe(404);
    const market = h.s.markets.get(f.marketId)!;
    const resolved = { ...h.s, markets: new Map(h.s.markets).set(f.marketId, { ...market, state: 6, payouts: [1, 0], evidence_uri: "ipfs://e" }) };
    h.live.finalizedSnapshot = resolved;
    expect((await h.get("/resolutions/" + f.marketId)).body.error).toContain("has not been indexed");
    h.db.resolution = { signature: "sig", data: { account: owner } };
    expect((await h.get("/resolutions/" + f.marketId)).body).toMatchObject({
      admin: owner,
      yesPayout: "1",
      noPayout: "0",
      payoutDenominator: "1",
      evidenceUri: "ipfs://e",
      transactionHash: "sig",
    });
  });

  test("trades merge finalized rows with the confirmed tail without duplicates", async () => {
    const h = harness();
    await h.service.start();
    const market = new PublicKey(f.marketId);
    h.service.onCommit(notice("confirmed", { ...h.s, slot: 101 }, [tx(101, "c1", [trade(market, 1)]), tx(101, "dup", [trade(market, 2)])]));
    h.db.tradeRows = [
      { signature: "dup", event_index: 0, market: f.marketId, block_time: "5", data: { branch: 0, price: "1", quantity: "2", base: 1, base_amount: "2", quote: "2", maker: "m", taker: "t" } },
      { signature: "old", event_index: 0, market: f.marketId, block_time: null, data: { branch: 1, price: "1", quantity: "4", base: 2, base_amount: "4", quote: "4", maker: "m", taker: "t" } },
    ];
    const trades = (await h.get("/trades")).body.trades;
    expect(trades.map((t: { id: string; confirmation: string }) => [t.id, t.confirmation])).toEqual([
      ["c1:0", "confirmed"],
      ["dup:0", "finalized"],
      ["old:0", "finalized"],
    ]);
    expect(trades[0]).toMatchObject({ marketId: f.marketId, fillQuantity: "1", base: 1, blockTimestamp: String(1_700_000_101) });
    expect(trades[2].blockTimestamp).toBeNull();
    expect((await h.get("/trades?limit=1")).body.trades.length).toBe(1);
    expect((await h.get("/trades?marketId=" + f.marketId)).body.trades.length).toBe(3);
    expect((await h.get("/trades?marketId=unknown")).body.trades).toEqual([]);
    expect((await h.get("/trades?limit=0")).status).toBe(400);
    expect((await h.get("/trades?limit=abc")).status).toBe(400);
  });
});

