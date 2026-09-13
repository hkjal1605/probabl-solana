import { type SQL, sql } from "drizzle-orm";
import { isolatedCacheSchema } from "./cache-policy.ts";

export { isolatedCacheSchema } from "./cache-policy.ts";

export interface CacheConnection {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface CacheDatabase {
  transaction<T>(work: (connection: CacheConnection) => Promise<T>): Promise<T>;
}

const identifier = (value: string) => sql.identifier(value);
const tableName = (schema: string, table: string) =>
  sql`${identifier(schema)}.${identifier(table)}`;

/** Ponder 0.17.8 checkpoint layout. Reject drift; never guess a recovery boundary. */
export function checkpointBlock(checkpoint: unknown, chainId: number): bigint {
  if (
    typeof checkpoint !== "string" ||
    !/^\d{75}$/.test(checkpoint) ||
    BigInt(checkpoint.slice(10, 26)) !== BigInt(chainId)
  )
    throw new Error("unsupported Ponder checkpoint encoding or chain");
  return BigInt(checkpoint.slice(26, 42));
}

export function createCacheQueries(
  database: CacheDatabase,
  options: {
    schema: string;
    chainId: number;
    retention: number;
    batchSize: number;
  },
) {
  const cacheSchema = isolatedCacheSchema(options.schema);
  if (
    ![options.retention, options.batchSize].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    options.batchSize > 10_000
  )
    throw new Error("cache retention and batch size must be positive safe integers");
  const checkpoint = tableName(options.schema, "_ponder_checkpoint");
  const intervals = tableName(cacheSchema, "intervals");
  // All are rebuildable cache tables. Never touch application state, checkpoints,
  // rollback journals or factory discovery (which is needed across the full history).
  const tables = [
    ["blocks", "number"],
    ["logs", "block_number"],
    ["transactions", "block_number"],
    ["transaction_receipts", "block_number"],
    ["traces", "block_number"],
    ["rpc_request_results", "block_number"],
  ] as const;

  async function prune() {
    return database.transaction(async (connection) => {
      // Fail fast on contention. This maintenance transaction never holds an app-row lock.
      await connection.execute(sql`SELECT set_config('lock_timeout', '100ms', true),
        set_config('statement_timeout', '500ms', true)`);
      const result = await connection.execute(sql`
        SELECT safe_checkpoint, finalized_checkpoint, latest_checkpoint FROM ${checkpoint}
        WHERE chain_id = ${options.chainId}`);
      const row = result.rows[0];
      if (!row) return { cutoff: 0n, deleted: 0, perTable: {} as Record<string, number> };
      const safe = checkpointBlock(row.safe_checkpoint, options.chainId);
      const finalized = checkpointBlock(row.finalized_checkpoint, options.chainId);
      const latest = checkpointBlock(row.latest_checkpoint, options.chainId);
      const boundary = [safe, finalized, latest].reduce((a, b) => (a < b ? a : b));
      const cutoff =
        boundary > BigInt(options.retention) ? boundary - BigInt(options.retention) : 0n;
      if (cutoff === 0n) return { cutoff, deleted: 0, perTable: {} as Record<string, number> };

      // Coverage and data eviction commit atomically. A fresh replay must refetch
      // evicted ranges; it must never mistake an absent cached log for an empty block.
      // Ponder uses [start, end + 1] ranges; keeping from cutoff (inclusive) is conservative.
      const mutations: SQL[] = [
        sql`coverage AS (UPDATE ${intervals}
        SET blocks = blocks * nummultirange(numrange(${cutoff.toString()}::numeric, NULL, '[)'))
        WHERE chain_id = ${options.chainId}
        AND blocks && nummultirange(numrange(NULL, ${cutoff.toString()}::numeric, '()')) RETURNING 1)`,
      ];

      for (const [index, [name, column]] of tables.entries()) {
        const table = tableName(cacheSchema, name);
        // Existing (chain_id, block_number, ...) indexes bound every seek and delete.
        const victims = identifier(`victims_${index}`);
        const removed = identifier(`removed_${index}`);
        mutations.push(
          sql`${victims} AS MATERIALIZED (
          SELECT ctid FROM ${table} WHERE chain_id = ${options.chainId}
            AND ${identifier(column)} < ${cutoff.toString()}::bigint
          ORDER BY ${identifier(column)} LIMIT ${options.batchSize}
        )`,
          sql`${removed} AS (
          DELETE FROM ${table} AS doomed USING ${victims}
          WHERE doomed.ctid = ${victims}.ctid RETURNING 1
        )`,
        );
      }
      // One short mutation statement, not six serial network round trips while
      // holding the coverage-row lock. PostgreSQL aborts the entire sweep on timeout.
      const deleted = await connection.execute(sql`WITH ${sql.join(mutations, sql`, `)}
        SELECT ${sql.join(
          tables.map(
            ([name], index) =>
              sql`(SELECT count(*)::integer FROM ${identifier(`removed_${index}`)}) AS ${identifier(name)}`,
          ),
          sql`, `,
        )}`);
      const perTable = Object.fromEntries(
        tables.map(([name]) => [name, Number(deleted.rows[0]?.[name] ?? 0)]),
      );
      return { cutoff, deleted: Object.values(perTable).reduce((a, b) => a + b, 0), perTable };
    });
  }
  return { prune, cacheSchema };
}
