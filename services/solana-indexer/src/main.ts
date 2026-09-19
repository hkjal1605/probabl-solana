import { Hono } from "hono";
import { cors } from "hono/cors";
import { createSolanaDatabase } from "@conditional-stocks/db/solana";
import { persistSnapshot } from "./storage";
import { reconcileLedger } from "./custody";
import { payoutCredits } from "./payouts";
import { SolanaClient, key, hex, type MarketAccount } from "@conditional-stocks/solana-client";
import { snapshot, marketView, indexedOrder, liveOrder, type Snapshot } from "./projection.ts";
import { createIndexStream, changedTopics } from "./stream";
import { WalletIndex } from "./wallet-index";
import { creationTimes, replayHistory } from "./history.ts";
import { reconcileVaults } from "./reconcile.ts";
import { retiredOrderImages, restoreRetiredOrders } from "./retired-orders.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const client = new SolanaClient({
  rpcUrl: required("SOLANA_RPC_URL"),
  config: required("SOLANA_CONFIG"),
  genesisHash: required("SOLANA_GENESIS_HASH"),
  ...(process.env.SOLANA_PROGRAM_ID ? { programId: process.env.SOLANA_PROGRAM_ID } : {}),
});
const db = createSolanaDatabase({
  connectionString: required("DATABASE_URL"),
  max: 4,
  applicationName: "probabl-solana-indexer",
});
const domain = `${client.deployment.genesisHash}:${client.program}:${client.config}`;
await db.verify();
let current: Snapshot | undefined,
  lastError: string | null = null;
let walletIndex: WalletIndex | undefined;
let reconciliation: Awaited<ReturnType<typeof reconcileVaults>> | undefined;
let lastAudit = 0;
const indexStream = createIndexStream();
async function refresh() {
  try {
    const next = await snapshot(client);
    reconcileLedger(next);
    const changed = JSON.stringify(next.rawAccounts) !== JSON.stringify(current?.rawAccounts);
    if (changed || Date.now() - lastAudit >= 30_000) {
      await replayHistory(db, client, domain, next.slot, next);
      reconciliation = await reconcileVaults(client, next);
      lastAudit = Date.now();
    }
    next.createdAt = creationTimes(await db.creationEvents(domain, next.slot));
    const retired = await db.retiredEvents(domain, next.slot);
    const retiredOrders = retiredOrderImages(retired);
    restoreRetiredOrders(next, retiredOrders);
    if (!(await persistSnapshot(db, domain, next, retiredOrders)))
      throw new Error("A newer indexer snapshot is already committed");
    const update = changedTopics(current, next);
    current = next;
    lastError = null;
    void walletIndex?.refreshOwners(update.owners);
    indexStream.publish(update);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Indexer refresh failed";
    console.error(lastError);
    await db.failSnapshot(domain, current?.slot ?? 0).catch(() => {});
  }
}
await refresh();
let stopped = false;
let refreshFailures = 0;
const loop = async () => {
  while (!stopped) {
    await Bun.sleep(Math.min(15_000, 5000 * 2 ** Math.min(refreshFailures, 4)));
    if (!stopped) {
      await refresh();
      refreshFailures = lastError ? refreshFailures + 1 : 0;
    }
  }
};
const running = loop();
const app = new Hono();
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    exposeHeaders: ["Retry-After"],
    maxAge: 3600,
  }),
);
const state = () => {
  if (!current || lastError || Date.now() - current.observedAt > 15_000)
    throw new Error("Finalized indexer snapshot unavailable");
  return current;
};
app.onError(
  (error) =>
    new Response(JSON.stringify({ error: { message: error.message } }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "3",
      },
    }),
);
walletIndex = new WalletIndex(client, db, domain, state);

let walletRefreshing = false;
const walletTimer = setInterval(() => {
  if (walletRefreshing) return;
  walletRefreshing = true;
  void walletIndex!.refresh().finally(() => {
    walletRefreshing = false;
  });
}, 10_000);
indexStream.mount(app, state, walletIndex);
app.get("/health", (c) => {
  const s = state();
  return c.json({
    healthy: true,
    chain: "solana",
    head: { confirmedBlock: String(s.slot), finalizedBlock: String(s.slot) },
  });
});
app.get("/reconciliation", (c) => {
  state();
  if (!reconciliation) throw new Error("Vault reconciliation is not available");
  return c.json(reconciliation);
});
app.get("/markets", (c) => {
  const s = state();
  return c.json({
    markets: [...s.markets].map(([id, m]) => marketView(id, m, s.createdAt?.get(id))),
  });
});
app.get("/markets/:id", (c) => {
  const id = c.req.param("id"),
    s = state(),
    m = s.markets.get(id);
  return m ? c.json(marketView(id, m, s.createdAt?.get(id))) : c.json({ error: "not-found" }, 404);
});
app.get("/orders", (c) => {
  const s = state(),
    maker = c.req.query("maker"),
    status = c.req.query("status");
  const rows = [...s.orders].filter(
    ([, o]) =>
      (!maker || o.owner.toBase58() === maker) && (!status || status !== "open" || o.status === 1),
  );
  return c.json({
    orders: rows.map(([id, o]) => indexedOrder(id, o, s.slot)),
    truncated: false,
    nextCursor: null,
  });
});
app.get("/orderbook/:id", (c) => {
  const s = state(),
    id = c.req.param("id");
  return c.json({
    orders: [...s.orders]
      .filter(([, o]) => o.market.toBase58() === id && liveOrder(o, s))
      .map(([id, o]) => indexedOrder(id, o, s.slot)),
    truncated: false,
  });
});
app.get("/orderbooks", (c) => {
  const s = state();
  const books: Record<string, { orders: ReturnType<typeof indexedOrder>[]; truncated: false }> = {};
  for (const id of s.markets.keys()) books[id] = { orders: [], truncated: false };
  for (const [id, order] of s.orders) {
    if (!liveOrder(order, s)) continue;
    books[order.market.toBase58()]?.orders.push(indexedOrder(id, order, s.slot));
  }
  return c.json({ books, slot: String(s.slot) });
});
app.get("/positions/:owner", async (c) => {
  state();
  const owner = key(c.req.param("owner")).toBase58();
  c.header("Cache-Control", "no-store");
  const response = await walletIndex!.get(owner);
  state(); // Don't publish cached wallet reads after indexer integrity/readiness failed.
  return c.json(response);
});
app.get("/balances/:owner", async (c) => {
  const owner = key(c.req.param("owner")),
    mint = key(c.req.query("token") ?? "");
  state();
  c.header("Cache-Control", "no-store");
  const image = await walletIndex!.get(owner.toBase58());
  const response = image.balances[mint.toBase58()];
  if (!response) return c.json({ error: "Mint is not indexed for this deployment" }, 404);
  state();
  return c.json(response);
});
app.get("/payouts/:owner", (c) =>
  c.json({
    vault: client.program.toBase58(),
    payouts: payoutCredits(state(), key(c.req.param("owner")).toBase58()),
    nextCursor: null,
  }),
);
app.get("/resolutions/:id", async (c) => {
  const m: MarketAccount | undefined = state().markets.get(c.req.param("id"));
  if (!m || ![6, 7].includes(m.state)) return c.json({ error: "not-found" }, 404);
  const event = await db.resolutionEvent(domain, c.req.param("id"), state().slot);
  if (!event) throw new Error("Resolution transaction has not been indexed");
  return c.json({
    admin: event.data.account,
    evidenceHash: hex(m.evidence),
    evidenceUri: m.evidence_uri,
    yesPayout: String(m.payouts[0]),
    noPayout: String(m.payouts[1]),
    payoutDenominator: String(m.payouts[0]! + m.payouts[1]!),
    transactionHash: event.signature,
  });
});
app.get("/trades", async (c) => {
  const s = state(),
    market = c.req.query("marketId"),
    limit = Number(c.req.query("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    return c.json({ error: "Invalid limit" }, 400);
  if (market && !s.markets.has(market)) return c.json({ trades: [] });
  const rows = await db.trades(domain, market ? [market] : [...s.markets.keys()], s.slot, limit);
  return c.json({
    trades: rows.map((r) => ({
      id: r.signature + ":" + r.event_index,
      marketId: r.market,
      branch: r.data.branch,
      blockTimestamp: String(r.block_time),
      executionPriceRawX18: r.data.price,
      fillQuantity: r.data.quantity,
      executionQuote: r.data.quote,
      makerOrderHash: r.data.maker,
      takerOrderHash: r.data.taker,
      transactionHash: r.signature,
      confirmation: "finalized",
    })),
  });
});
const server = Bun.serve({
  idleTimeout: 60,
  hostname: process.env.INDEXER_HOST ?? "127.0.0.1",
  port: Number(process.env.INDEXER_PORT ?? 42069),
  fetch: app.fetch,
});
console.info(`Solana indexer listening on ${server.url}`);
let shutdown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (shutdown) return;
    shutdown = true;
    stopped = true;
    clearInterval(walletTimer);
    void server
      .stop()
      .then(() => running)
      .then(() => db.close());
  });
