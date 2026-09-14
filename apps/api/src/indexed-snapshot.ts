import type { Pool } from "pg";
import type { SolanaClient } from "@conditional-stocks/solana-client";
import { decodeSnapshot } from "@conditional-stocks/solana-indexer/projection";

/** No RPC fallback: an unhealthy/unmigrated index must not silently become a full-chain scan. */
export async function indexedSnapshot(db: Pick<Pool, "query">, client: SolanaClient, domain: string) {
  const schema = process.env.INDEXER_SNAPSHOT_SCHEMA;
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid indexer snapshot schema");
  const table = schema ? `"${schema}".solana_snapshots` : "solana_snapshots";
  const result = await db.query(
    `SELECT slot, accounts, extract(epoch from observed_at)*1000 AS observed_at_ms
     FROM ${table} WHERE domain=$1 AND observed_at > now()-interval '15 seconds'
     AND accounts->>'healthy'='true'`,
    [domain],
  );
  const row = result.rows[0];
  if (!row || !Array.isArray(row.accounts?.rawAccounts))
    throw new Error("Indexed trading snapshot unavailable. Wait for the indexer to catch up.");
  const slot = Number(row.slot);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("Invalid indexed slot");
  const snapshot = decodeSnapshot(client, slot, row.accounts.rawAccounts);
  snapshot.observedAt = Number(row.observed_at_ms);
  return snapshot;
}
