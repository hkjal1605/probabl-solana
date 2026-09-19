import { SNAPSHOT_VERSION, type SolanaQueries } from "@conditional-stocks/db/solana";
import type { SolanaClient } from "@conditional-stocks/solana-client";
import { decodeSnapshot } from "@conditional-stocks/solana-indexer/projection";
import { restoreRetiredOrders } from "@conditional-stocks/solana-indexer/retired-orders";

/** No RPC fallback: an unhealthy/unmigrated index must not silently become a full-chain scan. */
export async function indexedSnapshot(
  db: Pick<SolanaQueries, "snapshot">,
  client: SolanaClient,
  domain: string,
) {
  const row = await db.snapshot(domain, process.env.INDEXER_SNAPSHOT_SCHEMA);
  if (
    !row ||
    row.accounts?.version !== SNAPSHOT_VERSION ||
    !Array.isArray(row.accounts?.rawAccounts)
  )
    throw new Error("Indexed trading snapshot unavailable. Wait for the indexer to catch up.");
  const slot = Number(row.slot);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("Invalid indexed slot");
  const snapshot = decodeSnapshot(client, slot, row.accounts.rawAccounts);
  if (row.accounts.retiredOrders) restoreRetiredOrders(snapshot, row.accounts.retiredOrders);
  snapshot.observedAt = Number(row.observed_at_ms);
  return snapshot;
}
