import { Hono } from "hono";
import { Pool } from "pg";
import {
  SolanaClient,
  big,
  key,
  hex,
  walletAddress,
  type MarketAccount,
} from "@conditional-stocks/solana-client";
import { snapshot, marketView, indexedOrder, liveOrder, type Snapshot } from "./projection.ts";
import { createIndexStream, changedTopics } from "./stream";
import { WalletIndex } from "./wallet-index";
import { initializeHistory, replayHistory } from "./history.ts";
import { reconcileVaults } from "./reconcile.ts";

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
const db = new Pool({
  connectionString: required("DATABASE_URL"),
  max: 4,
  statement_timeout: 15_000,
});
const domain = `${client.deployment.genesisHash}:${client.program}:${client.config}`;
await db.query(
  `CREATE TABLE IF NOT EXISTS solana_snapshots (domain text PRIMARY KEY, slot bigint NOT NULL, observed_at timestamptz NOT NULL, accounts jsonb NOT NULL)`,
);
await initializeHistory(db);
let current: Snapshot | undefined,
  lastError: string | null = null;
let reconciliation: Awaited<ReturnType<typeof reconcileVaults>> | undefined;
let lastAudit = 0;
const indexStream = createIndexStream();
async function refresh() {
  try {
    const next = await snapshot(client);
    const changed = JSON.stringify(next.rawAccounts) !== JSON.stringify(current?.rawAccounts);
    if (changed || Date.now() - lastAudit >= 30_000) {
      await replayHistory(db, client, domain, next.slot);
      reconciliation = await reconcileVaults(client, [...next.markets.keys()], next.slot);
      lastAudit = Date.now();
    }
    // A single atomic upsert prevents concurrent/restarted indexers publishing an older slot.
    await db.query(
      `INSERT INTO solana_snapshots VALUES ($1,$2,to_timestamp($4::double precision/1000),$3::jsonb)
      ON CONFLICT (domain) DO UPDATE SET slot=EXCLUDED.slot,observed_at=EXCLUDED.observed_at,accounts=EXCLUDED.accounts
      WHERE solana_snapshots.slot <= EXCLUDED.slot`,
      [
        domain,
        next.slot,
        JSON.stringify({
          healthy: true,
          rawAccounts: next.rawAccounts,
          markets: [...next.markets].map(([id, m]) => marketView(id, m)),
          orders: [...next.orders].map(([id, o]) => indexedOrder(id, o, next.slot)),
        }),
        next.observedAt,
      ],
    );
    const update = changedTopics(current, next);
    current = next;
    lastError = null;
    indexStream.publish(update);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Indexer refresh failed";
    console.error(lastError);
    await db.query("UPDATE solana_snapshots SET accounts=jsonb_set(accounts,'{healthy}','false') WHERE domain=$1", [domain]).catch(() => {});
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
const walletIndex = new WalletIndex(client, db, domain, state);
await walletIndex.initialize();
let walletRefreshing = false;
const walletTimer = setInterval(() => {
  if (walletRefreshing) return;
  walletRefreshing = true;
  void walletIndex.refresh().finally(() => { walletRefreshing = false; });
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
app.get("/markets", (c) =>
  c.json({ markets: [...state().markets].map(([id, m]) => marketView(id, m)) }),
);
app.get("/markets/:id", (c) => {
  const id = c.req.param("id"),
    m = state().markets.get(id);
  return m ? c.json(marketView(id, m)) : c.json({ error: "not-found" }, 404);
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
app.get("/positions/:owner", async (c) => {
  state();
  const owner = key(c.req.param("owner")).toBase58();
  c.header("Cache-Control", "no-store");
  const response = await walletIndex.get(owner);
  state(); // Don't publish cached wallet reads after indexer integrity/readiness failed.
  return c.json(response);
});
app.get("/balances/:owner", async (c) => {
  const owner = key(c.req.param("owner")),
    mint = key(c.req.query("token") ?? "");
  state();
  c.header("Cache-Control", "no-store");
  const image = await walletIndex.get(owner.toBase58());
  const response = image.balances[mint.toBase58()];
  if (!response) return c.json({ error: "Mint is not indexed for this deployment" }, 404);
  state();
  return c.json(response);
});
app.get("/payouts/:owner", (c) => {
  const s = state(),
    owner = key(c.req.param("owner")),
    payouts = [];
  for (const [id, m] of s.markets) {
    const w = s.wallets.get(walletAddress(key(id), owner, client.program).toBase58());
    if (!w) continue;
    for (let asset = 0; asset < 6; asset++) {
      const amount = big(w.balances[asset]!);
      if (!amount) continue;
      const collateral = asset < 2 ? asset : Math.floor((asset - 2) / 2);
      payouts.push({
        id: `${id}:${asset}`,
        beneficiary: owner.toBase58(),
        asset: m.mints[asset]!.toBase58(),
        tokenId: String(asset),
        amount: amount.toString(),
        collateralToken: m.mints[collateral]!.toBase58(),
        decimals: m.decimals[collateral],
        branch: asset < 2 ? null : asset % 2 === 0 ? "YES" : "NO",
        kind: collateral === 0 ? "stock" : "quote",
        marketId: id,
        confirmation: "finalized",
      });
    }
  }
  return c.json({
    vault: client.program.toBase58(),
    payouts,
    nextCursor: null,
  });
});
app.get("/resolutions/:id", async (c) => {
  const m: MarketAccount | undefined = state().markets.get(c.req.param("id"));
  if (!m || ![6, 7].includes(m.state)) return c.json({ error: "not-found" }, 404);
  const event = await db.query(
    `SELECT signature,data FROM solana_events WHERE domain=$1 AND market=$2 AND name='Change' AND data->>'kind'='3' ORDER BY slot DESC LIMIT 1`,
    [domain, c.req.param("id")],
  );
  if (!event.rows[0]) throw new Error("Resolution transaction has not been indexed");
  return c.json({
    admin: event.rows[0].data.account,
    evidenceHash: hex(m.evidence),
    evidenceUri: m.evidence_uri,
    yesPayout: String(m.payouts[0]),
    noPayout: String(m.payouts[1]),
    payoutDenominator: String(m.payouts[0]! + m.payouts[1]!),
    transactionHash: event.rows[0].signature,
  });
});
app.get("/trades", async (c) => {
  const s = state(),
    market = c.req.query("marketId"),
    limit = Number(c.req.query("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    return c.json({ error: "Invalid limit" }, 400);
  if (market && !s.markets.has(market)) return c.json({ trades: [] });
  const rows = await db.query(
    `SELECT * FROM solana_events WHERE domain=$1 AND name='Trade' AND market=ANY($2::text[])
    AND slot <= $3 ORDER BY slot DESC,signature DESC,event_index DESC LIMIT $4`,
    [domain, market ? [market] : [...s.markets.keys()], s.slot, limit],
  );
  return c.json({
    trades: rows.rows.map((r) => ({
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
      .then(() => db.end());
  });
