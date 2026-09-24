import { createSolanaDatabase } from "@conditional-stocks/db/solana";
import { requestLogging } from "@conditional-stocks/shared/http";
import { configureDevnetIssuerReplicas } from "@conditional-stocks/shared/spot-prices";
import { parseReplicaMints } from "@conditional-stocks/shared/token-catalog";
import { SolanaClient, underlyingAsset } from "@conditional-stocks/solana-client";
import { LiveIndex, relayClientFactory, type GeyserClient } from "@conditional-stocks/solana-indexer/live";
import YellowstoneClient from "@triton-one/yellowstone-grpc";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { browserCors } from "../common/browser-cors.ts";
import { logger } from "../common/logger.ts";
import { JupiterSpotPrices, jupiterEnvironment } from "../integrations/jupiter/prices.ts";
import { mountSolanaAdmin } from "./admin/routes.ts";
import { mountAuthentication } from "./auth/routes.ts";
import { mountCustody } from "./custody/routes.ts";
import { mountTradingReadiness } from "./health/readiness-routes.ts";
import { mountHealth } from "./health/routes.ts";
import { mountMarketSpotPrices, mountSpotPrices } from "./market-data/spot-routes.ts";
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
// Trading reads come from an in-process live index, one block behind the
// chain, with no database round trip or snapshot decode per request. It reads
// the indexer's loopback relay (INDEXER_RELAY_URL), so the host keeps a single
// billed Yellowstone subscription; YELLOWSTONE_GRPC_URL is a standalone fallback.
const relayUrl = process.env.INDEXER_RELAY_URL;
const geyserToken = process.env.YELLOWSTONE_X_TOKEN || undefined;
const live = new LiveIndex({
  client,
  geyser: relayUrl
    ? relayClientFactory(relayUrl)
    : ({ compression }) =>
        new YellowstoneClient(
          required("YELLOWSTONE_GRPC_URL"),
          geyserToken,
          { grpcMaxDecodingMessageSize: 64 * 1024 * 1024, ...(compression ? { grpcDefaultCompressionAlgorithm: 1 } : {}) },
          { enabled: false },
        ) as unknown as GeyserClient,
  source: { compression: process.env.YELLOWSTONE_COMPRESSION !== "none" },
  onError: (error) => logger.error("live.index.error", { error }),
});
await live.start();
const legTimer = setInterval(() => live.refreshLegs(), 2_000);
legTimer.unref?.();
// Keeper-maintained lookup tables (indexer LookupKeeper) let placements carry
// every protocol maker; refresh the list the shared client compiles with.
const refreshLookupTables = async () => {
  try {
    client.useLookupTables(await db.lookupTables(domain));
  } catch (error) {
    logger.error("lookup.tables.refresh.failed", { error });
  }
};
await refreshLookupTables();
const lookupTimer = setInterval(() => void refreshLookupTables(), 5_000);
lookupTimer.unref?.();

const app = new Hono();
app.use("*", browserCors(origins));
app.use("*", requestLogging(logger));
// Devnet replicas of mainnet issuer tokens price as the token they replicate.
configureDevnetIssuerReplicas(parseReplicaMints(process.env.SOLANA_ISSUER_REPLICA_MINTS));
const spotPrices = new JupiterSpotPrices(
  client.deployment.genesisHash,
  jupiterEnvironment(process.env),
);
mountSpotPrices(app, spotPrices);
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
const readIndex = async () => {
  if (!live.health().healthy) throw new HTTPException(503, { message: "Live chain index unavailable" });
  return live.confirmed();
};
mountTradingReadiness(app, {
  assertNetwork: async () => {}, // Domain-bound snapshots were verified by the indexer.
  configAccount: async () => (await readIndex()).config,
  market: async (address) => {
    const market = (await readIndex()).markets.get(address.toBase58());
    if (!market) throw new Error("Unknown indexed market");
    return market;
  },
});
mountMarketSpotPrices(app, spotPrices, async (id) => {
  const snapshot = await readIndex();
  const market = snapshot.markets.get(id);
  if (!market) throw new HTTPException(404, { message: "Unknown indexed market" });
  // Streamed issuer state (pause, freeze, multiplier) of the confirmed view.
  const legs = snapshot.legs?.get(id) ?? null;
  return {
    quoteMint: market.mints[0]!.toBase58(),
    bases: Array.from({ length: market.bases }, (_, i) => {
      const collateral = i + 1,
        leg = legs?.[collateral];
      return {
        collateral,
        mint: market.mints[underlyingAsset(collateral)]!.toBase58(),
        multiplierValue: leg && leg.halt !== "unreadable" ? leg.multiplierValue : null,
        tradable: leg ? leg.tradable : null,
        halt: leg ? leg.halt : null,
      };
    }),
  };
});
const authenticate = mountAuthentication(app, db, client, domain, origins);
const prepare = createOrderPlan(client, readIndex);
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
    live.stop();
    void server.stop().then(() => db.close());
  });
