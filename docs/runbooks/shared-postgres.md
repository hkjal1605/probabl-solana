# One database for Probabl

All backend processes use one PostgreSQL/Aurora PostgreSQL writer endpoint and database.
There is no embedded database fallback, including in development. Browser applications use
the APIs; never put database credentials in frontend environment variables.

`packages/db` owns Drizzle schemas, migrations, pools, transactions and named query functions.
Ponder owns only the configured projection schema and `cs_sync_<projection>` cache schema.
Operational schemas are `probabl`, `gateway`, and `operations`.
Their names are forbidden as Ponder projection names. Replaying chain history cannot recover
sessions, pending signed transactions or human evidence: back up the whole database.

## Provision and start

1. Create the database with automated backups/PITR, encryption and private networking. Use
   the writer endpoint, validated TLS certificates, and independent migration credentials.
2. Set `DATABASE_URL`, `ROBINHOOD_CHAIN_ID` and the verified `EXCHANGE_ADDRESS`. Run
   `bun run db:migrate` as the migration owner. Runtime processes never migrate automatically.
3. Have the database administrator apply `packages/db/provision-roles.sql`. Create individual
   service logins/IAM users and grant each its corresponding NOLOGIN privilege group.
   Do not make runtime users database/table owners or members of the migration owner.
4. Give each service its own credentials for the **same endpoint and database** using
   `DATABASE_URL`. The indexer role may create its projection/cache schemas but has no write
   access to operational state. All services verify chain/exchange identity and migration hashes.
5. Set `DATABASE_POOL_SIZE` per ordinary service (default 10, allowed 1–100).
   `PONDER_DATABASE_POOL_SIZE` is Ponder's separate total budget (default 20, allowed 5–100).
   Budget the sum across replicas, migrations and administration below the server limit.
6. Use `DATABASE_SCHEMA=probabl_atomic_v1` for the indexer; keep it and retention settings
   stable on restart. Start indexer, reconciler, ingestor, then API/UI.
   Wait for initial deep reconciliation and all readiness gates before accepting orders.

Remove obsolete local-store environment variables. They are rejected, not silently ignored.
No database URL, key, session or signed transaction belongs in application logs.
Ponder uses session features, LISTEN/NOTIFY, and advisory locks; use a direct PostgreSQL
connection or a specifically validated session-preserving proxy, not transaction pooling.

## Durability and concurrency

Ordinary writes use `synchronous_commit=on`; the pinned Ponder patch enforces this too and
bounds read-pool `work_mem` to 16 MB. Keep server `fsync`/durability enabled. The pool size
and transaction deadlines bound contention; load-test them on the chosen Aurora instance.
No guarantee of zero added network latency is implied by replacing in-process storage.

Atomic trading has no database queue, trading signer, nonce allocator or matcher journal.
The API computes a bounded plan from Ponder's canonical order projection; the user's wallet
broadcasts it. Only user-signed cancellation/merge/redemption operations retain the durable
gateway outbox. Exact signed bytes commit before broadcast; retries rebroadcast those bytes,
not newly signed orders. Server-clock ownership tokens reject stale recovery writers.
Bounded recovery pages run separately from intake.

Keep one active Polymarket feed process until multi-instance upstream subscription ownership
has been separately rehearsed. A common database does not itself validate arbitrary HA scaling.
Socket generations fence late callbacks; a 1,000-event backlog ceiling triggers disconnect and
fresh snapshot recovery instead of unbounded buffering. Independent quote requests can progress concurrently; quotes do not reserve liquidity.

Evidence bytes, immutable packets/reviews and their indexed content links live in PostgreSQL.
Point `ADMIN_EVIDENCE_PUBLIC_BASE_URL` at the API's HTTPS `/v1/attachments` route (or a reverse
proxy to it). Only attachments referenced by approved evidence can be downloaded there;
draft/unreferenced content returns 404. Downloads are attachment-only and `nosniff`.
Packet validation failure rolls back newly inserted bytes as well as packet/audit records.

## Retiring the development matcher

Applied migration history 0000–0003 is retained unchanged. Migration 0004 locks and checks
legacy proposal/batch/IOC/order-outbox tables, refuses pending trading work, then removes
the retired matching and settlement tables/schemas. Migration 0005 removes the unused
relayer nonce table. Back up any development history you want to keep **before** migrating;
terminal legacy operational records are deliberately removed. No live database is modified
by the test suite. Stop old processes before running migrations and never bypass the pending
work guard. Prefer a fresh database for a fresh non-upgradeable contract deployment.

Use a fresh Ponder projection schema and replay for this release: the duplicate matcher
event projection is gone, and order history now retains an explicit executed `filled`
quantity independently of cancelled escrow. Authentication, user recovery outboxes, operator evidence,
reconciliation and Polymarket records remain in their operational schemas.

## Tests and recovery

`bun run test:ts` starts an owned temporary PostgreSQL cluster when `TEST_DATABASE_URL` is
absent; PostgreSQL binaries must be on PATH. Alternatively supply an isolated loopback test
server whose test user can create databases. Tests create/drop only generated fixture databases.
Never point tests at a remote or production database. Temporary cluster logs are retained.

`bun run test:coverage` also checks unmeasured runtime files, not just files imported by tests.
The requested 100% coverage target is still work in progress; a passing functional suite is not
a 100% coverage claim. See the migration implementation record for the latest verified state.

For a deployment rehearsal run `bun packages/contracts/scripts/verify-internal-stack.ts`;
add `--storage` for retention, crash/reorg and clean-rebuild checks. It starts its own local
PostgreSQL/Anvil instances and does not submit upstream transactions. Freeze source/migrations
for the duration of a rehearsal; startup rejects a schema from a different release.
Add `--production-ui` to build/start both frontends in `.next-rehearsal`, separate from `.next`.
Deploy the workspace with `packages/db/migrations` present. The API build keeps package imports
external so migration discovery remains relative to the database package; do not deploy its
`dist/index.js` as a standalone file without workspace dependencies. Build frontend deployment
artifacts again using the deployment environment, not the local rehearsal settings.

Restore the whole database to a consistent recovery point during disaster recovery. Stop
trading first, reconcile stored user recovery outboxes with chain receipts, then rebuild projections
if necessary. Never truncate operational schemas to repair Ponder. Old local database files
and historical audit artifacts are not read, migrated or deleted by service startup.
