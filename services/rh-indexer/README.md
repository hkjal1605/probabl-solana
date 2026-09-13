# Robinhood Chain indexer and reconciliation

This service is the canonical offchain projection for Conditional Stocks v2 raw-unit ratios. It uses
[Ponder](https://ponder.sh/docs/get-started/new-project) to synchronize Robinhood Chain logs,
handle reorg rollbacks, and transactionally build typed PostgreSQL read models. Hono routes
serve those projections to the atomic candidate API, portfolio, and operations services.

The chain remains the source of truth. This database may be discarded and rebuilt from the
configured deployment block. It must never be edited to “repair” custody or accounting.

## Architecture

`ponder.config.ts` pins every protocol address and ABI. Token metadata is read at `MarketCreated`;
we do not subscribe to global ERC-20 transfers. One block filter maintains the canonical indexed, confirmed, and finalized
heads. All contract handlers use `context.db`, making a log and every projection change one
reorg-aware Ponder database transaction.

The projection contains:

- a bounded recent block ring, relevant transactions, and event-delivery guards;
- market terms, claim IDs, and current market state;
- order state, reservations, open interest, fills, and paid fees;
- current ERC-1155 claim balances, nonce floors, pauses, and manual resolution evidence.

Rows store their canonical block/hash and cursor. Confirmation is derived from `indexer_state`
instead of rewriting every row whenever the head advances. If a reorg occurs, Ponder atomically
rolls affected handler writes back and replays the canonical branch. Orphaned data is not exposed as
canonical history.

## RPC and database policy

All environments use the shared PostgreSQL `DATABASE_URL` and a unique Ponder `DATABASE_SCHEMA`. Run operational Drizzle migrations before starting the launcher. Configure comma-separated `ROBINHOOD_RPC_URL` values for failover and
an optional `ROBINHOOD_WS_URL`. Ponder owns log batching, caching, retries, and reorg handling; no
second custom polling loop exists.

`INDEXER_GET_LOGS_BLOCK_RANGE` caps provider log ranges when required. Leave
`PONDER_DISABLE_CACHE` unset/false on RH: bounded retention preserves useful recent caching.
`INDEXER_END_BLOCK` is only for a bounded, pinned
rebuild. Before startup, `preflight.ts` rejects the wrong chain, missing code, dependency wiring,
manifest address drift, and deployed runtime-bytecode hash drift.

## Bounded idle storage and durable restarts

Use the package `start`/`dev` scripts or `bun scripts/ponder.ts start|dev`; a direct `ponder start`
is rejected by configuration. The launcher checks Ponder **0.17.8** and our committed Bun patch.
Install using `bun install --frozen-lockfile`; do not omit `patches/` from deployment images.

- `INDEXER_BLOCK_RETENTION=8192`: the canonical block table has at most this many slots. Each
  overwrite remains in Ponder's transaction/rollback machinery. There is no block-table sweep.
- `INDEXER_CACHE_RETENTION=8192`: keep this many blocks *before* Ponder's minimum safe/finalized/
  latest recovery boundary. Unfinalized/recovery lag and the cleanup interval add to this window.
- `INDEXER_CACHE_MAINTENANCE_INTERVAL_MS=15000` and `INDEXER_CACHE_MAINTENANCE_BATCH_SIZE=2000`:
  one non-overlapping maintenance transaction per interval, at most this many rows per cache table.
  It uses existing range indexes, a 100 ms lock timeout and a 500 ms statement timeout. The six
  bounded deletions and coverage trim are one SQL statement, with no immediate retry. It does not
  run in a block handler, create another connection pool, or stop indexing if maintenance fails.

The disposable cache is isolated in `cs_sync_<DATABASE_SCHEMA>`. Another deployment/rebuild uses
its own cache, even on the same PostgreSQL database. Cache data and cached-range coverage are
evicted atomically, so future replays refetch missing ranges. Factory discovery remains intact.
The adapter resumes fetching at the extraction/recovery cursor instead of refetching an evicted
deployment-to-checkpoint prefix. Application state, recovery checkpoints and rollback journals
are **never** deleted by cache maintenance. Keep the same schema and persistent storage on restart.

Older atomic candidate/reconciliation block anchors fall back to exact-block RPC reads with head hash
revalidation; unavailable historical headers or branch disagreement fail closed. Recent anchor
reads remain database-only. The RPC must retain historical block headers; this fallback does not
require historical `eth_call` state. Simultaneous misses are coalesced and concurrency bounded.

Monitor `indexer.storage.ready`, `indexer.cache.pruned`, `indexer.cache.backlog` and
`indexer.cache.maintenance_failed`, plus Ponder finality/lag metrics and PostgreSQL autovacuum/WAL.
Storage is not an exact byte quota: stalled finality intentionally retains recovery data, backfill
prefetch temporarily stages data, and real protocol/recovery/UI history still grows with use.
Autovacuum must reclaim deleted row versions; table allocation and WAL need not shrink immediately.

This schema change requires a fresh application schema/replay. Changing the anchor ring size on
an existing schema fails closed. Old application and shared `ponder_sync` schemas are left untouched;
retire them only after verification and backup. Never use `ponder db prune` as cache maintenance:
it deletes inactive deployments, not just their RPC cache.

## Local Anvil workflow

Build the contracts once, then use separate terminals:

```bash
bun run build:contracts
bun run anvil:indexer
bun run anvil:indexer:bootstrap
bun run dev:indexer:anvil
```

Bootstrap deploys six-decimal mock USDG/eighteen-decimal Stock Token, the complete v2 protocol, and one open market, then writes
the ignored `services/rh-indexer/.env.anvil`. The generated manifest contains installed runtime
bytecode hashes, including immutable constructor values.

Exercise the trade and resolution paths:

```bash
bun run seed:indexer:anvil
bun run reconcile:indexer:anvil
bun run resolve:indexer:anvil
bun run reconcile:indexer:anvil
```

The seed submits two EIP-712-signed, whole-collateral GTC orders and partially fills them through the
owner's atomic placement transaction. There is no privileged matcher. The resolution fixture releases the remaining reservations and performs the
manual admin-only YES resolution. Neither fixture is available on a non-Anvil chain.

## Production commands

```bash
bun --filter @conditional-stocks/rh-indexer preflight
bun --filter @conditional-stocks/rh-indexer start
bun --filter @conditional-stocks/rh-indexer reconcile
bun --filter @conditional-stocks/rh-indexer reconcile:continuous
```

Run the Ponder process and continuous reconciler as separately supervised services. Keep the
reconciler's Hono control API on its default loopback binding or a private authenticated service
network. The `/internal/*` Ponder routes are also service-only and require ingress authentication in
production.

## Read API

| Route | Purpose |
| --- | --- |
| `GET /indexer/health` | Indexed/confirmed/finalized head and head age |
| `GET /metrics` | Ponder's built-in Prometheus runtime and sync metrics |
| `GET /internal/match-candidates` | Bounded eligible opposite-side GTC makers, best price then FIFO, bound to a canonical block |
| `GET /markets[/:id]` | Current market terms and state |
| `GET /orders/:id` | Canonical order and confirmation state |
| `GET /trades` | Cursor-orderable fills, optionally by market |
| `GET /balances/:account` | Claim balances; optional canonical token balance via `?token=...` |
| `GET /positions/:account` | Market-grouped claim and redemption state |
| `GET /resolutions/:id` | Manual payout and evidence record |
| `GET /internal/reservations` | Positive exchange reservations |
| `GET /internal/reconciliation-snapshot` | Aggregated accounting input |

Atomic candidate parameters are `marketId`, `branch`, maker `side`, `limitPriceRawX18`,
`makerFeeBps`, `atBlock` and latest execution `timestamp`. The query excludes non-open/IOC,
expired, nonce-invalidated, noncrossing, fee-ineligible and anchor-ineligible rows before
the 33-row window. It returns chain/exchange/block identity with full maker orders,
hashes, remaining quantities and onchain sequences. Integers are decimal JSON strings;
no application-specific canonical codec is required. Quotes cannot reserve orders.
Old matcher-event, IOC-book and settlement context/confirmation endpoints are removed.

## Reconciliation

Continuous runs aggregate balances, while deep runs additionally read each open order and each
manual resolution vector. HTTP transport batching combines independent `eth_call` requests. Reads
are pinned to the exact indexed block.

The engine checks:

- exchange ERC-20/ERC-1155 custody equals summed positive reservations;
- CTF collateral covers outstanding YES/NO liabilities, exactly when the deployment has a
  dedicated CTF;
- settlement and position-router transient balances are zero;
- projected open-order fields equal `getOrderState`;
- controller, registry, CTF payout, and evidence projections agree.

Critical differences create durable market/global freeze signals in a shared PostgreSQL control
store. The watch service exposes `/health`, `/freeze-signals`, and `/metrics` on port `42070`. A clean
run at equivalent depth clears a signal; a shallow run cannot clear a deep-only failure. Milestone
11 must reject new order intake for active scopes. Reconciliation never submits transactions and
never modifies a Ponder balance.

Every report stores a versioned deterministic projection hash. `verify:rebuild` compares two deep
snapshots at the same block/hash:

```bash
PRIMARY_INDEXER_URL=http://127.0.0.1:42069 \
REBUILT_INDEXER_URL=http://127.0.0.1:42071 \
bun --filter @conditional-stocks/rh-indexer verify:rebuild
```

See [indexer rebuild](../../docs/runbooks/indexer-rebuild.md) and
[reorg response](../../docs/runbooks/indexer-reorg.md).
