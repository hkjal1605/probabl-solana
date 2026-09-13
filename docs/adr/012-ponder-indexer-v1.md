# ADR-012 — Ponder indexer for v1

Status: Accepted

Persistence amendment (2026-09-08): the original local PGlite/control-database choice
below is superseded by [one shared PostgreSQL database](../runbooks/shared-postgres.md)
in development, tests and production. Reconciler control tables are a separate schema,
not a separate database. Ponder's projection/sync schemas remain isolated from them.

## Context

The projection service must process registry, exchange, CTF, lifecycle, and resolution events from
the deployment block; survive duplicate delivery and reorgs; serve confirmed ordered events to the
matcher; and rebuild without a database backup. A custom synchronizer would duplicate difficult
RPC range, cache, transactional rollback, factory-address discovery, and reorg logic.

## Decision

Use pinned Ponder `0.17.8` as the v1 Robinhood Chain synchronization and projection runtime. Use
Ponder's typed schema and `context.db` transactions, PostgreSQL in production, PGlite locally, Hono
for read APIs. As of the September 7 storage audit, do not subscribe to every transfer of
market-discovered ERC-20 contracts: those transfers include unrelated chain activity and have no
product consumer. Canonical ERC-20 balances are read at pinned blocks through RPC; protocol CTF
transfers remain indexed for claims, liabilities and positions.

Keep custody reconciliation as a separate read-only process. It consumes a consistent Ponder
snapshot, pins direct Viem reads to that indexed block, and stores only reports/freeze signals in an
independent control database.

## Alternatives

A custom Viem polling loop, Subsquid, The Graph, and database-trigger projections were considered.
The custom loop creates the greatest correctness burden. Hosted-only approaches weaken local
rebuild and fault-injection workflows. The selected architecture remains self-hostable and keeps
business projections in repository-owned TypeScript.

## Consequences

Ponder's canonical rollback semantics define how orphaned projection rows disappear. Confirmation
labels are derived from one canonical head row to avoid write amplification. Matcher consumers must
carry block hashes and honor HTTP `409` rewind responses. Projection meaning is versioned with a
deterministic checkpoint hash and verified against clean replay.

Ponder version upgrades are production changes: review release notes, replay into a new database
schema, compare projection hashes at a pinned block, load test, and promote through the rebuild
runbook.

## Security assumptions

RPC providers can be incomplete or inconsistent. Startup verifies chain, address, dependency, and
runtime-bytecode identity; production uses independent RPC endpoints; reconciliation compares the
projection with direct contract state. A Ponder bug or bad handler remains possible and is not a
reason to bypass freeze signals.

## Reversal cost

Raw event cursors, matcher payloads, APIs, and checkpoint formats are repository-owned. Another
indexer can be shadowed from the same deployment block and promoted only after pinned replay hashes
and downstream behavior agree.
