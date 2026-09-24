import { createSolanaDatabase } from "@conditional-stocks/db/solana";
import { SolanaClient } from "@conditional-stocks/solana-client";
import YellowstoneClient from "@triton-one/yellowstone-grpc";
import { Keypair } from "@solana/web3.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ChainRelay, LiveIndex, type GeyserClient } from "./live/index.ts";
import { LookupKeeper } from "./lookup-keeper.ts";
import { IndexerService } from "./service.ts";

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
await client.assertNetwork();
const db = createSolanaDatabase({
  connectionString: required("DATABASE_URL"),
  max: 4,
  applicationName: "probabl-solana-indexer",
});
const domain = `${client.deployment.genesisHash}:${client.program}:${client.config}`;
await db.verify();

// Yellowstone gRPC (Geyser) endpoint: Alchemy, Triton, Helius LaserStream,
// QuickNode, or a local validator running the yellowstone-grpc-geyser plugin.
// Billed per streamed byte: updates are zstd-compressed unless disabled.
const geyserUrl = required("YELLOWSTONE_GRPC_URL");
const geyserToken = process.env.YELLOWSTONE_X_TOKEN || undefined;
const geyser = ({ compression }: { compression: boolean }) =>
  new YellowstoneClient(
    geyserUrl,
    geyserToken,
    { grpcMaxDecodingMessageSize: 64 * 1024 * 1024, ...(compression ? { grpcDefaultCompressionAlgorithm: 1 /* zstd */ } : {}) },
    { enabled: false },
  ) as unknown as GeyserClient;

// The only upstream subscription on the host: co-located consumers (the API)
// read the same events from this loopback relay instead of a second stream.
const relay = new ChainRelay();
const relayPort = Number(process.env.INDEXER_RELAY_PORT ?? 42070);
if (relayPort) relay.serve(relayPort, "127.0.0.1");

let service: IndexerService;
const live = new LiveIndex({
  client,
  geyser,
  source: { compression: process.env.YELLOWSTONE_COMPRESSION !== "none" },
  onEvent: (event) => relay.publish(event),
  onCommit: (notice) => service?.onCommit(notice),
  onResync: () => {
    relay.reset();
    service?.onResync();
  },
  onError: (error) => console.error("Live index: " + (error instanceof Error ? error.message : String(error))),
});
service = new IndexerService(client, db, domain, live);
await service.start();

// Issuer multipliers take effect at their timestamps without any account change.
const legTimer = setInterval(() => live.refreshLegs(), 2_000);
const walletTimer = setInterval(() => void service.wallets.refresh().catch(() => {}), 10_000);

// Optional lookup-table keeper: without it placements fit only ~5 makers.
const keeperKeypair = process.env.SOLANA_LOOKUP_KEEPER_KEYPAIR?.trim();
const keeper = keeperKeypair
  ? new LookupKeeper(
      client.connection,
      client,
      db,
      domain,
      Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await Bun.file(keeperKeypair).text()))),
      {
        dailyAddressBudget: Number(process.env.SOLANA_LOOKUP_KEEPER_DAILY_ADDRESSES ?? 20_000),
        owners: process.env.SOLANA_LOOKUP_KEEPER_OWNERS,
      },
    )
  : undefined;
const keeperTimer = keeper
  ? setInterval(() => {
      let snapshot;
      try {
        snapshot = service.trading();
      } catch {
        return;
      }
      void keeper.sync(snapshot).then(
        (result) => {
          if (result.extended || result.created) console.info(JSON.stringify({ event: "lookup-keeper", ...result }));
        },
        (error) => console.error("Lookup keeper failed: " + (error instanceof Error ? error.message : String(error))),
      );
    }, 1_000)
  : undefined;

const app = new Hono();
app.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], exposeHeaders: ["Retry-After"], maxAge: 3600 }));
app.onError(
  (error) =>
    new Response(JSON.stringify({ error: { message: error.message } }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "1" },
    }),
);
service.mount(app);
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
    clearInterval(legTimer);
    clearInterval(walletTimer);
    if (keeperTimer) clearInterval(keeperTimer);
    live.stop();
    relay.stop();
    void server
      .stop()
      .then(() => service.drain())
      .then(() => db.close());
  });
