# Milestone 10 — Chain indexer and reconciliation

## Goal

Build the canonical offchain projection layer and continuous accounting checks before exposing production trading APIs or user interfaces.

## Implementation status

Implemented with Ponder `0.17.8`, Hono, PostgreSQL/PGlite, Viem, and a separate durable Bun SQLite reconciliation-control store. Ponder owns log synchronization, RPC caching/batching, database transactions, and canonical reorg rollback. The service does not maintain a competing block-polling implementation.

The implementation lives in `services/rh-indexer`; architecture and local commands are documented in its README. Operational procedures are in `docs/runbooks/indexer-reorg.md` and `docs/runbooks/indexer-rebuild.md`.

## Dependencies

- Milestone 04 registry events.
- Milestones 05–08 exchange, position, and resolution events.
- Milestone 09 matcher input requirements.

## Indexer responsibilities

- Start from configured deployment blocks and verified contract addresses.
- Decode registry, exchange, CTF, resolution, and pause events.
- Persist canonical block/hash and event cursor metadata. Derive observed/confirmed/finalized status from the indexed head to avoid write amplification; Ponder removes orphaned handler writes transactionally during reorg rollback.
- Build projections for markets, orders, reservations, fills, balances, claims, merges, redemptions, and manual resolutions.
- Expose an ordered canonical event stream to the matcher.
- Rebuild all projections from raw logs without application database backups.

## Confirmation and reorg policy

- Define observed, confirmed, and finalized states for Robinhood Chain.
- Never expose an order as live to the matcher before the configured confirmation state.
- Use Ponder's canonical sync engine to detect and roll back discontinuities, then replay the replacement branch. Reject stale downstream block-hash cursors with an explicit rewind point.
- Publish user-facing pending/final status rather than hiding chain uncertainty.
- Store versioned projection/checkpoint hashes for comparison with a clean replay.

## Core tables

Implement the source-plan aggregates:

- markets and state transitions;
- orders, reservations, fills, and book checkpoints;
- chain transactions and account balance projections;
- claim positions and merge/redemption records;
- manual resolution evidence references and transactions;
- raw append-only logs and indexer cursors.

No KYC, eligibility, jurisdiction, or compliance-provider tables belong in v1.

## Reconciliation

Continuously compare:

```text
exchange ERC-20/ERC-1155 balances
  versus per-order reservations and documented transients

CTF collateral locked
  versus outstanding claims and redeemed amounts

onchain order remaining/reserved
  versus database and matcher state

onchain fills
  versus statements, analytics, and matcher proposals

admin evidence packet
  versus local ResolutionFinalized vector and evidence hash
```

Any unexplained mismatch freezes affected new trading and alerts an operator. Never repair custody data by editing a database balance.

## APIs for downstream consumers

Provide stable read models or internal queries for:

- current market/state/configuration;
- canonical order status and remaining/reserved amount;
- trades and book reconstruction;
- wallet whole/claim/reserved balances;
- mergeable/redeemable positions;
- resolution status/evidence;
- indexer health, head lag, and confirmation status.

## Tests

- Replay from deployment block into an empty database.
- Duplicate log delivery and idempotent ingestion.
- Removed/orphaned log and multi-block reorg simulations.
- Contract upgrade/address misconfiguration rejection.
- Random event streams compared with direct contract state.
- Reconciliation mismatch injection and automatic trading-freeze signal.
- Checkpoint corruption rejection and clean rebuild.
- Large books, many partial fills, and bounded query performance.

### Implemented evidence

- Unit tests cover environment rejection, deterministic checkpoint hashing, and durable freeze-signal activation/clearing semantics.
- Anvil integration exercised deployment replay, EIP-712 order opens, partial fill, reservation release, claim issuance, market lifecycle, and manual admin resolution.
- Two independent empty PGlite databases replayed through the same block/hash and produced the same projection-v1 hash.
- Snapshot/revert replacement blocks proved Ponder rollback convergence and stale matcher cursors returned HTTP `409` with a rewind point.
- Unexpected settlement and zero-expected exchange balances produced critical global/market freeze signals; reverting the fault and replaying cleared them after a clean deep run.
- Deep reconciliation compared all known exchange assets (including expected-zero balances), CTF liabilities, router transients, every open order, market/wallet open interest, and resolution vectors with direct reads pinned to the indexed block.

Production-scale load, long-running randomized chain streams, real Robinhood Chain reorg characteristics, and independent RPC disagreement drills remain Milestone 14 release gates rather than reasons to weaken the v1 projection model.

## Deliverables

- `services/rh-indexer`.
- Ponder-managed projection schema plus versioned deterministic projection hashes; explicit reconciliation-store migrations.
- Canonical event-stream contract for matcher/services.
- Continuous and daily reconciliation jobs.
- Reorg and indexer-rebuild runbooks.
- Health and accounting metrics.

## Exit criteria

- [x] A clean replay reproduces all markets, orders, fills, claims, and resolutions.
- [x] Duplicate logs cannot duplicate state.
- [x] Reorg handling converges to direct onchain state.
- [x] Every contract balance is explained by reservations, claims, or documented transients.
- [x] Mismatches produce an operator-visible alert and scoped freeze signal.
- [x] Downstream consumers never need Redis as a source of truth.

## Non-goals

- Matching orders.
- Signing or submitting transactions.
- Polymarket probability ingestion.
- Identity or KYC data storage.
