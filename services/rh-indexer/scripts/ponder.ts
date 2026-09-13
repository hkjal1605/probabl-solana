/** Version-pinned Ponder entrypoint. Only chain projections are Ponder-owned. */
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadDatabaseOptions, openDatabase } from "@conditional-stocks/db/connection";
import {
  type CacheConnection,
  type CacheDatabase,
  createCacheQueries,
  isolatedCacheSchema,
} from "@conditional-stocks/db/indexer/cache";
import { loadIndexerEnvironment } from "../src/environment.ts";
import { logger } from "../src/logger.ts";

interface QueryBuilder {
  wrap<T>(query: (connection: CacheConnection) => Promise<T>): Promise<T>;
  transaction<T>(query: (connection: QueryBuilder) => Promise<T>): Promise<T>;
  raw: CacheConnection & {
    transaction<T>(query: (connection: CacheConnection) => Promise<T>): Promise<T>;
  };
}
interface Runtime {
  database: { syncQB: QueryBuilder };
  namespaceBuild: { schema: string };
  common: { shutdown: { add(callback: () => unknown): void; isKilled: boolean } };
  indexingBuild: { chains: { id: number }[] };
  preBuild: { ordering: string };
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    schema: { type: "string" },
    port: { type: "string", short: "p" },
    hostname: { type: "string", short: "H" },
    "log-level": { type: "string" },
    "log-format": { type: "string" },
    "disable-ui": { type: "boolean" },
    "views-schema": { type: "string" },
  },
});
const command = positionals[0] ?? "start";
if (positionals.length > 1 || !["start", "dev", "serve"].includes(command))
  throw new Error("Usage: bun scripts/ponder.ts start|dev|serve [--schema NAME] [--port PORT]");
process.chdir(resolve(import.meta.dir, ".."));
const schema =
  values.schema ?? process.env.DATABASE_SCHEMA ?? (command === "dev" ? "local_v3" : "");
const syncSchema = isolatedCacheSchema(schema);
process.env.DATABASE_SCHEMA = schema;
if (process.env.PONDER_SYNC_SCHEMA && process.env.PONDER_SYNC_SCHEMA !== syncSchema)
  throw new Error("PONDER_SYNC_SCHEMA is derived from DATABASE_SCHEMA; do not override it");
process.env.PONDER_SYNC_SCHEMA = syncSchema;
// Prevent a direct, unmaintained CLI from silently selecting the shared cache.
process.env.CONDITIONAL_INDEXER_RUNTIME = "bounded-cache-v1";
const environment = loadIndexerEnvironment(process.env);
const identityDatabase = await openDatabase(
  loadDatabaseOptions(process.env, "probabl-indexer-preflight"),
);
await identityDatabase.close();
const port = Number(values.port ?? process.env.PORT ?? "42069");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid indexer port");

const ponderRoot = dirname(Bun.resolveSync("ponder", import.meta.dir));
const version = (await Bun.file(resolve(ponderRoot, "../../package.json")).json()).version;
if (version !== "0.17.8")
  throw new Error("Review the bounded-cache adapter before changing Ponder version");
const cacheModule = await import(pathToFileURL(resolve(ponderRoot, "sync-store/schema.js")).href);
const postgresModule = await import(pathToFileURL(resolve(ponderRoot, "utils/pg.js")).href);
if (postgresModule.CONDITIONAL_STOCKS_POSTGRES_PATCH !== 1)
  throw new Error(
    "Pinned PostgreSQL durability patch is missing; reinstall the committed lockfile",
  );
if (
  cacheModule.CONDITIONAL_STOCKS_CACHE_PATCH !== 1 ||
  cacheModule.PONDER_SYNC_SCHEMA !== syncSchema
)
  throw new Error("Pinned Ponder cache patch is missing; install with the committed Bun lockfile");

async function onBuild(app: Runtime): Promise<Runtime> {
  if (
    app.namespaceBuild.schema !== schema ||
    app.preBuild.ordering !== "multichain" ||
    app.indexingBuild.chains.length !== 1 ||
    app.indexingBuild.chains[0]?.id !== environment.chainId
  )
    throw new Error("Bounded cache requires the configured single-chain multichain runtime");
  const connection: CacheDatabase = {
    // Reuse Ponder's pool, but do not retry maintenance inside its indexing retry
    // wrapper. A timeout skips this sweep and the next scheduled tick tries again.
    transaction: (work) => app.database.syncQB.raw.transaction(work),
  };
  const cache = createCacheQueries(connection, {
    schema,
    chainId: environment.chainId,
    retention: environment.cacheRetention,
    batchSize: environment.cacheMaintenanceBatchSize,
  });
  let active: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (active || stopped || app.common.shutdown.isKilled) return;
    active = (async () => {
      const began = performance.now();
      try {
        const result = await cache.prune();
        if (result.deleted > 0)
          logger.info("indexer.cache.pruned", { ...result, durationMs: performance.now() - began });
        if (
          Object.values(result.perTable).some(
            (count) => count === environment.cacheMaintenanceBatchSize,
          )
        )
          logger.warn("indexer.cache.backlog", {
            cutoff: result.cutoff,
            perTable: result.perTable,
          });
      } catch (error) {
        if (!stopped && !app.common.shutdown.isKilled)
          logger.error("indexer.cache.maintenance_failed", { error });
      }
    })().finally(() => {
      active = undefined;
    });
  };
  const timer = setInterval(tick, environment.cacheMaintenanceIntervalMs);
  timer.unref();
  app.common.shutdown.add(async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  });
  logger.info("indexer.storage.ready", {
    schema,
    syncSchema,
    blockRetention: environment.blockRetention,
    cacheRetention: environment.cacheRetention,
    maintenanceIntervalMs: environment.cacheMaintenanceIntervalMs,
    maintenanceBatchSize: environment.cacheMaintenanceBatchSize,
    ponderVersion: version,
    cachePatch: 1,
  });
  return app;
}

const runtime = await import(pathToFileURL(resolve(ponderRoot, `bin/commands/${command}.js`)).href);
await runtime[command]({
  cliOptions: {
    command,
    version,
    config: "ponder.config.ts",
    root: process.cwd(),
    schema,
    port,
    hostname: values.hostname,
    logLevel: values["log-level"],
    logFormat: values["log-format"] ?? "pretty",
    disableUi: values["disable-ui"],
    viewsSchema: values["views-schema"],
  },
  onBuild,
});
