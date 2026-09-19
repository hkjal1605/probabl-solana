import { createSolanaDatabase } from "@conditional-stocks/db/solana";
import { requestLogging } from "@conditional-stocks/shared/http";
import { ReadCache } from "@conditional-stocks/shared/read-cache";
import { SolanaClient } from "@conditional-stocks/solana-client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { browserCors } from "../common/browser-cors.ts";
import { logger } from "../common/logger.ts";
import { JupiterSpotPrices, jupiterEnvironment } from "../integrations/jupiter/prices.ts";
import { mountSolanaAdmin } from "./admin/routes.ts";
import { mountAuthentication } from "./auth/routes.ts";
import { indexedSnapshot } from "./chain/indexed-snapshot.ts";
import { mountCustody } from "./custody/routes.ts";
import { mountTradingReadiness } from "./health/readiness-routes.ts";
import { mountHealth } from "./health/routes.ts";
import { mountSpotPrices } from "./market-data/spot-routes.ts";
import { tradingSigner } from "./trading/delegated-orders.ts";
import { createOrderPlan } from "./trading/plan.ts";
import { mountTrading } from "./trading/routes.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const addressLookupTables = required("SOLANA_ADDRESS_LOOKUP_TABLES")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const client = new SolanaClient({
  rpcUrl: required("SOLANA_RPC_URL"),
  config: required("SOLANA_CONFIG"),
  genesisHash: required("SOLANA_GENESIS_HASH"),
  addressLookupTables,
  ...(process.env.SOLANA_PROGRAM_ID ? { programId: process.env.SOLANA_PROGRAM_ID } : {}),
});
const db = createSolanaDatabase({
  connectionString: required("DATABASE_URL"),
  max: 8,
  applicationName: "probabl-solana-api",
});
const origins = (process.env.API_AUTH_ORIGINS ?? required("API_AUTH_ORIGIN"))
  .split(",")
  .map((value) => new URL(value.trim()).origin);
const domain = `${client.deployment.genesisHash}:${client.program}:${client.config}`;
const delegateSigner = tradingSigner(
  process.env.TRADING_DELEGATE_PRIVATE_KEY,
  process.env.TRADING_DELEGATE_ADDRESS,
);

await Promise.all([client.assertNetwork(), client.lookupTables()]);
await db.verify();

const app = new Hono();
app.use("*", browserCors(origins));
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

mountHealth(app, db, client);
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
const authenticate = mountAuthentication(app, db, client, domain, origins);
const prepare = createOrderPlan(client, db, domain);
mountTrading(app, { client, db, domain, authenticate, readIndex, prepare, delegateSigner });
mountCustody(app, client, authenticate, readIndex);
const closeAdmin = await mountSolanaAdmin(app, db, client, domain, authenticate);

const server = Bun.serve({
  idleTimeout: 60,
  hostname: process.env.API_HOST ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3000),
  fetch: app.fetch,
});
console.info(`Solana API listening on ${server.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    closeAdmin();
    void server.stop().then(() => db.close());
  });
