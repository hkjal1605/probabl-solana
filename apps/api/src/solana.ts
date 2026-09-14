import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { Pool } from "pg";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { randomBytes, createHash } from "node:crypto";
import {
  SolanaClient,
  address,
  key,
  big,
  parseOrder,
  orderWire,
  orderId,
  planOrder,
  parseAtomicPlan,
  unsigned,
  quote,
  envelope,
  type OrderWire,
} from "@conditional-stocks/solana-client";
import { liveOrder } from "@conditional-stocks/solana-indexer/projection";
import { logger } from "./logger.ts";
import { requestLogging } from "@conditional-stocks/shared/http";
import { mountSolanaAdmin } from "./solana-admin.ts";
import { JupiterSpotPrices, jupiterEnvironment } from "./jupiter.ts";
import { mountSpotPrices } from "./spot-prices.ts";
import { mountTradingReadiness } from "./readiness.ts";
import { mountOrderReview } from "./order-review.ts";
import { indexedSnapshot } from "./indexed-snapshot.ts";
import { ReadCache } from "@conditional-stocks/shared/read-cache";

const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const client = new SolanaClient({
  rpcUrl: required("SOLANA_RPC_URL"),
  config: required("SOLANA_CONFIG"),
  genesisHash: required("SOLANA_GENESIS_HASH"),
  ...(process.env.SOLANA_PROGRAM_ID ? { programId: process.env.SOLANA_PROGRAM_ID } : {}),
});
const db = new Pool({
  connectionString: required("DATABASE_URL"),
  max: 8,
  statement_timeout: 15_000,
});
const origins = (process.env.API_AUTH_ORIGINS ?? required("API_AUTH_ORIGIN"))
  .split(",")
  .map((v) => new URL(v.trim()).origin);
const domain = `${client.deployment.genesisHash}:${client.program}:${client.config}`;
await client.assertNetwork();
await db.query(`CREATE TABLE IF NOT EXISTS solana_auth_challenges(id text PRIMARY KEY, domain text NOT NULL, owner text NOT NULL, message text NOT NULL, expires_at timestamptz NOT NULL);
  CREATE TABLE IF NOT EXISTS solana_sessions(token_hash text PRIMARY KEY, domain text NOT NULL, owner text NOT NULL, expires_at timestamptz NOT NULL)`);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const random = () => randomBytes(32).toString("hex");
const app = new Hono();
app.use("*", requestLogging(logger));
mountSpotPrices(
  app,
  new JupiterSpotPrices(client.deployment.genesisHash, jupiterEnvironment(process.env)),
);
app.use("*", async (c, next) =>
  bodyLimit({
    maxSize: /^\/v1\/admin\/evidence\/(creation|resolution)\/prepare$/.test(c.req.path)
      ? 36 * 1024 * 1024
      : 64_000,
  })(c, next),
);
app.onError(
  (error) =>
    new Response(JSON.stringify({ error: { message: error.message } }), {
      status: error instanceof HTTPException ? error.status : 400,
      headers: { "content-type": "application/json" },
    }),
);
async function authenticate(header: string | undefined) {
  if (!header || !/^Bearer [a-f0-9]{64}$/.test(header))
    throw new HTTPException(401, { message: "Sign in to continue" });
  const result = await db.query<{ owner: string }>(
    "SELECT owner FROM solana_sessions WHERE token_hash=$1 AND domain=$2 AND expires_at>now()",
    [hash(header.slice(7)), domain],
  );
  if (!result.rows[0]) throw new HTTPException(401, { message: "Session expired" });
  return result.rows[0].owner;
}
app.get("/health", (c) => c.json({ status: "ok", chain: "solana", service: "probabl-api" }));
app.get("/ready", async (c) => {
  try {
    await client.assertNetwork();
    const config = await client.configAccount();
    await db.query("SELECT 1");
    const response = await fetch(
      new URL("/reconciliation", process.env.INDEXER_URL ?? "http://127.0.0.1:42069"),
      { signal: AbortSignal.timeout(2000), redirect: "error" },
    );
    const indexed = (await response.json()) as { healthy?: boolean };
    const healthy = !config.paused && response.ok && indexed.healthy === true;
    return c.json({ healthy, chain: "solana" }, healthy ? 200 : 503);
  } catch {
    return c.json({ healthy: false, chain: "solana" }, 503);
  }
});
const indexedReads = new ReadCache(1000);
const readIndex = () => indexedReads.get("snapshot", () => indexedSnapshot(db, client, domain));
mountTradingReadiness(app, {
  assertNetwork: async () => {}, // Domain-bound snapshots were verified by the indexer.
  configAccount: async () => (await readIndex()).config,
  market: async (address) => {
    const market = (await readIndex()).markets.get(address.toBase58());
    if (!market) throw new Error("Unknown indexed market");
    return market;
  },
});
app.post("/v1/auth/challenge", async (c) => {
  const body = await c.req.json(),
    owner = address(body.address),
    id = random(),
    origin = body.origin;
  if (typeof origin !== "string" || !origins.includes(origin))
    throw new HTTPException(403, {
      message: "Sign-in origin is not authorized",
    });
  // Bound outstanding challenges per wallet and expire old state on every issuance.
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      domain + ":authentication",
    ]);
    await tx.query("DELETE FROM solana_auth_challenges WHERE expires_at<=now()");
    await tx.query("DELETE FROM solana_sessions WHERE expires_at<=now()");
    const total = await tx.query<{ count: string }>(
      "SELECT count(*) FROM solana_auth_challenges WHERE domain=$1",
      [domain],
    );
    if (Number(total.rows[0]?.count) >= 1000)
      throw new HTTPException(429, {
        message: "Sign-in capacity reached; retry after outstanding challenges expire",
      });
    const count = await tx.query<{ count: string }>(
      "SELECT count(*) FROM solana_auth_challenges WHERE domain=$1 AND owner=$2",
      [domain, owner],
    );
    if (Number(count.rows[0]?.count) >= 5) throw new Error("Too many pending sign-in requests");
    const message = `Sign in to probabl\nOrigin: ${origin}\nSolana genesis: ${client.deployment.genesisHash}\nProgram: ${client.program}\nConfig: ${client.config}\nWallet: ${owner}\nNonce: ${id}\nExpires: ${new Date(Date.now() + 120_000).toISOString()}`;
    await tx.query(
      "INSERT INTO solana_auth_challenges VALUES($1,$2,$3,$4,now()+interval '2 minutes')",
      [id, domain, owner, message],
    );
    await tx.query("COMMIT");
    return c.json({ challengeId: id, message });
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
});
app.post("/v1/auth/verify", async (c) => {
  const body = await c.req.json(),
    owner = address(body.address);
  if (
    typeof body.challengeId !== "string" ||
    typeof body.signature !== "string" ||
    body.signature.length > 128
  )
    throw new Error("Invalid authentication proof");
  const row = await db.query<{ message: string }>(
    "SELECT message FROM solana_auth_challenges WHERE id=$1 AND domain=$2 AND owner=$3 AND expires_at>now()",
    [body.challengeId, domain, owner],
  );
  if (!row.rows[0]) throw new Error("Challenge expired or consumed");
  const signature = bs58.decode(body.signature);
  if (
    signature.length !== 64 ||
    !nacl.sign.detached.verify(
      new TextEncoder().encode(row.rows[0].message),
      signature,
      key(owner).toBytes(),
    )
  )
    throw new Error("Invalid signature");
  const token = random(),
    tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const consumed = await tx.query(
      "DELETE FROM solana_auth_challenges WHERE id=$1 AND domain=$2 AND owner=$3 AND expires_at>now() RETURNING id",
      [body.challengeId, domain, owner],
    );
    if (consumed.rowCount !== 1) throw new Error("Challenge already consumed");
    const issued = await tx.query<{ expires_at_ms: string }>(
      "INSERT INTO solana_sessions VALUES($1,$2,$3,now()+interval '30 days') RETURNING (extract(epoch from expires_at)*1000)::bigint::text AS expires_at_ms",
      [hash(token), domain, owner],
    );
    await tx.query("COMMIT");
    return c.json({ token, expiresAtMs: Number(issued.rows[0]!.expires_at_ms) });
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
});

async function prepare(order: OrderWire) {
  const s = await indexedSnapshot(db, client, domain),
    m = s.markets.get(order.marketId);
  if (!m) throw new Error("Unknown market");
  const now = BigInt(Math.floor(Date.now() / 1000)),
    q = BigInt(order.quantity),
    p = BigInt(order.limitPriceRawX18),
    notional = quote(q, p, true);
  if (
    s.config.paused ||
    m.state !== 2 ||
    now < big(m.terms.trading_open) ||
    now >= big(m.terms.trading_cutoff) ||
    BigInt(order.expiry) <= now ||
    BigInt(order.expiry) > big(m.terms.trading_cutoff)
  )
    throw new Error("Market or order is not currently tradable");
  if (
    q % big(m.terms.step) !== 0n ||
    p % big(m.terms.tick) !== 0n ||
    q > big(m.terms.max_quantity) ||
    notional < big(m.terms.min_notional) ||
    notional > big(m.terms.max_order)
  )
    throw new Error("Order violates market terms");
  const trader = s.traders.get(order.maker);
  if (trader && BigInt(order.nonce) < big(trader.minimum_nonce))
    throw new Error("Order nonce was invalidated");
  const candidates = [...s.orders]
    .filter(
      ([, o]) =>
        o.market.toBase58() === order.marketId &&
        o.terms.branch === order.branch &&
        o.terms.side !== order.side &&
        liveOrder(o, s, now),
    )
    .map(([id, o]) => ({
      order: orderWire(o),
      orderHash: id,
      remaining: big(o.remaining),
      sequence: big(o.sequence),
    }));
  const plan = planOrder({
    program: client.program,
    order,
    candidates,
    now,
    step: big(m.terms.step),
    nextSequence: big(m.sequence[order.branch]!),
    makerFeeBps: s.config.maker_bps,
    takerFeeBps: s.config.taker_bps,
  });
  return {
    orderHash: orderId(order, client.program),
    order,
    notional: notional.toString(),
    plan,
    snapshotSlot: s.slot,
    atomicRouter: client.program.toBase58(),
    executionVersion: 1,
  };
}
mountOrderReview(app, prepare);
app.post("/v1/orders/transaction", async (c) => {
  const owner = await authenticate(c.req.header("authorization")),
    body = await c.req.json(),
    order = parseOrder(body.order);
  if (order.maker !== owner) throw new Error("Order signer differs from session wallet");
  const plan = parseAtomicPlan(body.plan, order);
  if (BigInt(plan.deadline) <= BigInt(Math.floor(Date.now() / 1000)))
    throw new Error("Quote expired");
  const transaction = envelope([client.placement(order, plan)], client.program);
  const built = await client.prepareTransaction(key(owner), transaction);
  const simulation = await client.connection.simulateTransaction(built.transaction, {
    sigVerify: false,
    commitment: "confirmed",
  });
  if (simulation.value.err)
    throw new Error(`Placement simulation failed: ${JSON.stringify(simulation.value.err)}`);
  return c.json({
    orderHash: orderId(order, client.program),
    executionVersion: 1,
    transaction,
  });
});
for (const kind of ["cancel", "recovery"])
  app.post(`/v1/orders/${kind}/prepare`, async (c) => {
    const owner = await authenticate(c.req.header("authorization")),
      body = await c.req.json();
    return c.json({
      transaction: envelope(
        [await client.cancel(key(address(body.orderHash)), key(owner))],
        client.program,
      ),
    });
  });
app.post("/v1/payouts/withdraw/prepare", async (c) => {
  const owner = await authenticate(c.req.header("authorization")),
    b = await c.req.json(),
    marketKey = key(address(b.marketId)),
    market = await client.market(marketKey);
  const asset = Number(b.tokenId),
    amount = unsigned(b.amount),
    recipient = key(address(b.recipient));
  if (
    !Number.isInteger(asset) ||
    asset < 0 ||
    asset > 5 ||
    !amount ||
    market.mints[asset]!.toBase58() !== b.asset
  )
    throw new Error("Invalid payout asset");
  return c.json({
    transaction: envelope(
      await client.withdrawCredit(
        marketKey,
        key(owner),
        market.mints[asset]!,
        asset,
        amount,
        recipient,
      ),
      client.program,
    ),
  });
});
await mountSolanaAdmin(app, db, client, domain, authenticate);
const server = Bun.serve({
  idleTimeout: 60,
  hostname: process.env.API_HOST ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3000),
  fetch: app.fetch,
});
console.info(`Solana API listening on ${server.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.stop().then(() => db.end());
  });
