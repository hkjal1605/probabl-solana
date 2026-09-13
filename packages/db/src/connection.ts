import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { Logger } from "@conditional-stocks/shared";
import { eq, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { type Address, getAddress } from "viem";
import { PublicKey } from "@solana/web3.js";
import * as schema from "./schema.ts";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
export interface DatabaseOptions {
  connectionString: string;
  chainId: number;
  exchange: Address | string;
  solanaNamespace?: string;
  applicationName?: string;
  maxConnections?: number;
}

export function databaseUrl(value: string | undefined): string {
  if (!value) throw new Error("DATABASE_URL is required; no local database fallback is supported");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2
  )
    throw new Error("DATABASE_URL must identify a PostgreSQL server and database");
  return value;
}

export function loadDatabaseOptions(
  environment: Record<string, string | undefined>,
  applicationName: string,
): DatabaseOptions {
  for (const name of [
    "API_DB_PATH",
    "MATCHER_DB_PATH",
    "SETTLEMENT_DB_PATH",
    "POLYMARKET_DB_PATH",
    "ADMIN_EVIDENCE_DB_PATH",
    "ADMIN_EVIDENCE_ATTACHMENT_DIR",
    "RECONCILIATION_DB_PATH",
    "PONDER_DATABASE_DIRECTORY",
  ])
    if (environment[name] !== undefined)
      throw new Error(`${name} is obsolete; configure the shared DATABASE_URL`);
  if(environment.SOLANA_CONFIG) {
    const keys=[environment.SOLANA_GENESIS_HASH,environment.SOLANA_PROGRAM_ID??"CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3",environment.SOLANA_CONFIG];
    for(const value of keys)if(!value||new PublicKey(value).toBase58()!==value)throw new Error("Invalid Solana database deployment identity");
    return {connectionString:databaseUrl(environment.DATABASE_URL),chainId:1,exchange:environment.SOLANA_CONFIG,
      solanaNamespace:"solana:"+keys.join(":"),applicationName};
  }
  const chainId = Number(environment.ROBINHOOD_CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    throw new Error("ROBINHOOD_CHAIN_ID is required for database isolation");
  const exchange = getAddress(environment.EXCHANGE_ADDRESS ?? "");
  const maxConnections = Number(environment.DATABASE_POOL_SIZE ?? "10");
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 100)
    throw new Error("DATABASE_POOL_SIZE must be between 1 and 100");
  return {
    connectionString: databaseUrl(environment.DATABASE_URL),
    chainId,
    exchange,
    applicationName,
    maxConnections,
  };
}

/** One bounded pool per service process; ordinary app transactions never use Ponder's writer. */
export function createDatabase(options: DatabaseOptions) {
  databaseUrl(options.connectionString);
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0)
    throw new Error("invalid database chain identity");
  const deploymentKey=options.solanaNamespace??options.exchange.toLowerCase(),orderVersion=options.solanaNamespace?4:3;
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "probabl",
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    // Session defaults also apply to nontransactional writes. Never disable certificate verification.
    options:
      "-c synchronous_commit=on -c work_mem=16MB -c idle_in_transaction_session_timeout=30000",
  });
  // pg emits idle-client errors separately; failed checked-out queries still reject to the caller.
  const logger = new Logger({ service: options.applicationName ?? "probabl-db" });
  pool.on("error", (error) => logger.error("database.idle-connection.failed", { error }));
  const root = drizzle(pool, { schema });
  const context = new AsyncLocalStorage<Transaction>();
  let closing: Promise<void> | undefined;
  const database = {
    chainId: BigInt(options.chainId),
    get session(): Database | Transaction {
      return context.getStore() ?? root;
    },
    async nowMs(): Promise<bigint> {
      const result = await database.session.execute<{ now: string }>(
        sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`,
      );
      if (!result.rows[0]) throw new Error("database clock unavailable");
      return BigInt(result.rows[0].now);
    },
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      if (context.getStore()) return work();
      // Callbacks may also update an in-memory matching engine. Replaying them implicitly,
      // even after a definite database rollback, would apply those side effects twice.
      // The service must recover its model and retry the complete idempotent operation.
      return root.transaction((tx) => context.run(tx, work));
    },
    async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
      return database.transaction(async () => {
        await database.session.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
        );
        return work();
      });
    },
    async verify() {
      const expected = readMigrationFiles({ migrationsFolder }).map((migration) => migration.hash);
      const applied = await root.execute<{ hash: string }>(
        sql`SELECT hash FROM probabl_migrations.__drizzle_migrations ORDER BY created_at`,
      );
      if (
        expected.length !== applied.rows.length ||
        expected.some((hash, index) => applied.rows[index]?.hash !== hash)
      )
        throw new Error(
          "Database migrations do not match this release; run db:migrate before starting services",
        );
      const [identity] = await root
        .select()
        .from(schema.deploymentIdentity)
        .where(eq(schema.deploymentIdentity.id, 1));
      if (
        !identity ||
        identity.chainId !== BigInt(options.chainId) ||
        identity.exchange !== deploymentKey ||
        identity.orderVersion !== orderVersion
      )
        throw new Error(
          "Database deployment mismatch or migrations missing; never reuse another deployment's operational state",
        );
    },
    async migrate() {
      // One connection holds a session lock while Drizzle runs its own migration transaction.
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended('probabl:migrations', 0))");
        await migrate(drizzle(client), {
          migrationsFolder,
          migrationsSchema: "probabl_migrations",
        });
        await drizzle(client)
          .insert(schema.deploymentIdentity)
          .values({
            id: 1,
            chainId: BigInt(options.chainId),
            exchange: deploymentKey,
            orderVersion,
          })
          .onConflictDoNothing();
      } finally {
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('probabl:migrations', 0))",
          );
        } finally {
          client.release();
        }
      }
      await database.verify();
    },
    close(): Promise<void> {
      closing ??= pool.end();
      return closing;
    },
  };
  return database;
}
export type ApplicationDatabase = ReturnType<typeof createDatabase>;

export async function openDatabase(options: DatabaseOptions): Promise<ApplicationDatabase> {
  const database = createDatabase(options);
  try {
    await database.verify();
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export function boundedLimit(value: number, fallback = 100, maximum = 500) {
  return Math.min(Math.max(Math.trunc(Number.isFinite(value) ? value : fallback), 1), maximum);
}
