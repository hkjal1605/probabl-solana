/** Read-only diagnostics for the owned native PostgreSQL integration rehearsal. */
import { SQL as Postgres } from "bun";
import { isolatedCacheSchema } from "./cache-policy.ts";

export function createStorageProbe(url: string, namespace: string) {
  const address = new URL(url);
  if (address.hostname !== "127.0.0.1" || address.port !== "19554")
    throw new Error("Storage rehearsal probe is restricted to the owned local PostgreSQL port");
  const cache = isolatedCacheSchema(namespace);
  const connection = new Postgres(url, { max: 1 });
  const qualified = (name: string, scope = namespace) =>
    `"${scope}"."${name.replaceAll('"', '""')}"`;
  async function stats() {
    const [row] = await connection.unsafe(
      `SELECT
      (SELECT count(*)::integer FROM ${qualified("chain_block")}) AS anchors,
      (SELECT min(number)::text FROM ${qualified("chain_block")}) AS oldest_anchor,
      (SELECT count(*)::integer FROM ${qualified("blocks", cache)}) AS cached_blocks,
      (SELECT min(number)::text FROM ${qualified("blocks", cache)}) AS oldest_cache,
      (SELECT count(*)::integer FROM ${qualified("rpc_request_results", cache)}) AS cached_calls,
      (SELECT safe_checkpoint FROM ${qualified("_ponder_checkpoint")} LIMIT 1) AS safe_checkpoint,
      (SELECT indexed_block::text FROM ${qualified("indexer_state")} LIMIT 1) AS indexed_block,
      (SELECT sum(pg_total_relation_size(c.oid))::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname IN ($1, $2)) AS table_bytes`,
      [namespace, cache],
    );
    return row as {
      anchors: number;
      oldest_anchor: string;
      cached_blocks: number;
      oldest_cache: string;
      cached_calls: number;
      safe_checkpoint: string;
      indexed_block: string;
      table_bytes: string;
    };
  }
  async function projection() {
    const result: Record<string, { count: number; digest: string }> = {};
    const tables = await connection.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      [namespace],
    );
    for (const table of tables) {
      const name = String(table.table_name);
      if (name.startsWith("_") || name === "chain_block" || name === "indexer_state") continue;
      const [row] = await connection.unsafe(`SELECT count(*)::integer AS count,
        md5(COALESCE(string_agg(row_to_json(t)::text, ',' ORDER BY row_to_json(t)::text), '')) AS digest
        FROM ${qualified(name)} t`);
      result[name] = row as { count: number; digest: string };
    }
    return result;
  }
  return { stats, projection, close: () => connection.close() };
}
