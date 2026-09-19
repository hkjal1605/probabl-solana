import { Pool } from "pg";
import { databaseUrl } from "../postgres-url.ts";
import { initializeStorage, SNAPSHOT_VERSION } from "./schema";
import { solanaQueries, writeSnapshot, type SolanaQueries } from "./queries";
import type { SnapshotWrite } from "./types";
export { SNAPSHOT_VERSION } from "./schema";
export { SignInCapacityError } from "./errors";
export type { SolanaQueries } from "./queries";
export type { HistoryCursor, StoredEvent } from "./types";

export function createSolanaDatabase(options: {
  connectionString: string;
  max?: number;
  applicationName?: string;
}) {
  const pool = new Pool({
    connectionString: databaseUrl(options.connectionString),
    max: options.max ?? 4,
    application_name: options.applicationName ?? "probabl-solana",
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
  pool.on("error", () => console.error("Solana database idle connection failed"));
  return solanaDatabase(pool);
}
/** Injection is used by database tests; services receive no SQL connection. */
export function solanaDatabase(pool: Pool) {
  async function transaction<T>(lock: string, work: (tx: import("pg").PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lock]);
      const result = await work(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  return {
    ...solanaQueries(pool),
    initialize: () => initializeStorage(pool),
    async verify() {
      const row = (await pool.query("SELECT version FROM solana_schema WHERE id=true")).rows[0];
      if (row?.version !== SNAPSHOT_VERSION)
        throw new Error("Solana database schema does not match this release");
    },
    locked<T>(lock: string, work: (queries: SolanaQueries) => Promise<T>) {
      return transaction(lock, (tx) => work(solanaQueries(tx)));
    },
    persistSnapshot(domain: string, snapshot: SnapshotWrite) {
      return transaction("snapshot:" + domain, (tx) => writeSnapshot(tx, domain, snapshot));
    },
    close: () => pool.end(),
  };
}
export type SolanaDatabase = ReturnType<typeof solanaDatabase>;
