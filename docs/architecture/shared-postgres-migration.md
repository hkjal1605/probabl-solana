# Shared PostgreSQL migration — implementation record

> Historical design record, superseded for trading execution on 2026-09-08 by [permissionless atomic placement](./atomic-placement.md). The matcher and settlement-worker runtime code, trading queues and nonce allocator have been removed. Do not use the old startup commands or trading endpoints below.

Status: in progress. This document is not a completion or production-readiness claim.

Progress snapshot (2026-09-08): all six adapters and service callers now use asynchronous
PostgreSQL queries. Workspace typechecking and Biome pass. The complete TypeScript suite
passes 239 tests / 3,872 assertions; all 147 contract tests pass. A 15-check shared-PostgreSQL/
Anvil rehearsal passed, including restart/reorg/clean replay and both production UI builds.
Cross-connection fencing, rollback, recovery fairness and actual database privilege restrictions
are tested. Coverage is **not yet 100%**; the strict inventory gate fails rather than omitting
unmeasured entrypoints/handlers. See the [verification report](../../audit/2026-09-08/shared-postgres/REPORT.md)
for evidence, exact limitations and outstanding coverage/hosted-infrastructure work.

Target: one PostgreSQL application database for every durable service store. No SQLite or PGlite runtime/test adapter. Ponder alone owns its reorg-managed projection and isolated sync schemas; ordinary application schemas use Drizzle migrations and never participate in chain rollback. All schema definitions, queries, connections and transactions live in `packages/db`.

Work sequence:

1. Inventory all six local stores, their callers, concurrency and restart invariants.
2. Add a shared bounded PostgreSQL connection boundary, typed Drizzle schemas and versioned migrations.
3. Replace gateway, matcher, settlement, evidence, Polymarket and reconciliation stores; preserve atomic signed outboxes, nonce allocation, idempotency and fencing.
4. Convert all services and tests to asynchronous named queries. Require DATABASE_URL; remove local-database defaults and SQLite/PGlite code paths, including development scripts.
5. Verify against actual PostgreSQL: transactions, concurrent processes/connections, failures, restarts, reorg isolation and complete integration flows. Measure service coverage without hiding untested runtime code.
6. Update deployment configuration/runbooks and report measured results and any remaining gaps.

Do not delete old user database files or historical audit artifacts. Removing local stores means removing active code/configuration/dependencies that create/use them, not destroying potentially valuable existing data. Any deployed operational-state cutover must preserve pending signatures, nonce reservations and evidence; no deployed production database is assumed here.
