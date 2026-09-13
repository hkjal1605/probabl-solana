# Indexer rebuild runbook

Use this runbook after projection-code changes, suspected database corruption, disaster recovery,
or periodic replay verification. Chain projections are rebuildable, but operational state is not:
whole-database backups remain essential for sessions, pending signed outboxes/nonces and evidence.

## Prepare a pinned comparison

1. Stop order intake and settlement submission. Existing contract cancellation, release, merge, and
   redemption paths remain available.
2. Record the primary's `indexedBlock`, `indexedBlockHash`, and a deep reconciliation
   `projectionHash`, then stop the primary Ponder process cleanly. Call the recorded block `H`.
3. Verify `H` is on the RPC's canonical chain. If it is not, follow the reorg runbook first.
4. Run `preflight` using the published deployment manifest. Do not continue after any chain,
   address, dependency, or bytecode mismatch.
5. Create a new, empty PostgreSQL schema. Never truncate or reuse the primary schema.

Set `INDEXER_END_BLOCK=H`, the new `DATABASE_SCHEMA`, a private alternate API port, and the same
deployment/RPC configuration. Start Ponder and wait for `/ready` plus `/indexer/health` at exactly
`H`.

For an offline pinned comparison, keep an API-only `scripts/ponder.ts serve` process on the retained
primary schema (PostgreSQL only), bound to loopback on a separate verification port. If `H` is older
than the normal head-age limit, set an explicit `INDEXER_MAX_HEAD_AGE_SECONDS` covering the replay
duration **only on these isolated verification processes**. Never route trading consumers to them
or relax the live trading freshness policy. Both snapshots must still pass canonical-hash checks.

For isolated local verification, use the same local PostgreSQL database and a fresh projection schema:

```bash
cd services/rh-indexer
INDEXER_END_BLOCK=H \
bun --env-file=.env.anvil scripts/ponder.ts start \
  --schema rebuild_v1 --port 42071 --hostname 127.0.0.1
```

## Verify

Run a deep reconciliation against the rebuilt instance. It must be clean. Then compare the primary
and rebuild at the identical block/hash:

```bash
PRIMARY_INDEXER_URL=http://127.0.0.1:42069 \
REBUILT_INDEXER_URL=http://127.0.0.1:42071 \
bun --filter @conditional-stocks/rh-indexer verify:rebuild
```

The projection version, hash, indexed block, and indexed block hash must match. Also compare row
counts for markets, orders, fills, claim balances, resolutions, processed event IDs.
The September 7 schema no longer stores unused lifecycle mirrors, raw event bodies or ERC-20
transfer deltas. Compare like-for-like schemas for these row counts; the v2 custody projection hash
continues to cover the same reconciliation rows and raw-unit meaning.
The bounded-storage schema also adds a fixed-size block ring and a stored ring size. A new schema
gets an isolated `cs_sync_<schema>` cache. Expect a full RPC replay for a new deployment schema;
normal restarts on the same schema resume from the persisted recovery checkpoint. Do not compare
raw cache counts or obsolete archived block counts as protocol-accounting evidence. Preserve the
ring size between restarts; changing it requires another fresh replay.
Any mismatch is an incident: keep trading stopped, retain both schemas, and inspect the first
divergent event. Never copy a balance or selected row from one schema to the other.

## Promote

1. Stop the bounded rebuild. Retain its schema as verification evidence.
2. Start the normal, unbounded configuration in another fresh application schema with
   `INDEXER_END_BLOCK` unset, and let its full replay reach the current head. Ponder includes source
   end-blocks in its build identity: removing `INDEXER_END_BLOCK` on the pinned schema is **not** a
   compatible persisted restart. Alternatively, rehearse two unbounded instances as in the storage
   integration harness, compare them at the same head, and promote without changing their source
   configuration.
3. Re-run deep reconciliation and confirm canonical candidate anchor/hash consistency.
4. Atomically route internal consumers to the new read API.
5. Resume settlement first in observation-only mode, then resume order intake after operations signs
   off.
6. Retain the old schema read-only through the incident/audit retention period.

If a clean replay cannot reproduce the projection, do not promote it and do not edit either
database. Fix the deterministic handler or configuration, increment the projection version when the
schema/meaning changes, and repeat from a new empty schema.
