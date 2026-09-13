# Database ownership and structured logging

## Database boundary

`packages/db` owns all authored PostgreSQL/Drizzle schemas and migrations, query/fetch functions, durable record types, the indexer's Ponder schema, projection write functions and read queries. Every service uses the same PostgreSQL database. Runtime services do not execute raw SQL. `services/rh-indexer/ponder.schema.ts` is only the entrypoint re-export required by Ponder; generated GraphQL/type files remain framework artifacts.

| Import | Responsibility |
| --- | --- |
| `@conditional-stocks/db/gateway` | Authentication challenges/sessions, user recovery operations and signed outbox |
| `@conditional-stocks/db/evidence` | Append-only operator evidence/reviews, previews, observations and attachment storage |
| `@conditional-stocks/db/reconciliation` | Reconciliation reports and persistent freeze signals |
| `@conditional-stocks/db/polymarket` | Immutable metadata/subscriptions, latest metadata pointers, one latest tick per condition and alerts |
| `@conditional-stocks/db/indexer/reads` | Read-only projected state, bounded atomic candidates, books, fills and consistent reconciliation snapshots |
| `@conditional-stocks/db/indexer/writes` | Named projection writes using Ponder's event-scoped database context |
| `@conditional-stocks/db/indexer/schema` | Canonical PostgreSQL projection schema |

```ts
import { createGatewayQueries } from "@conditional-stocks/db/gateway";
import { loadDatabaseOptions, openDatabase } from "@conditional-stocks/db/connection";

const database = await openDatabase(loadDatabaseOptions(process.env, "probabl-api"));
const queries = createGatewayQueries(database);
const operation = await queries.getOperation(operationId);
// Functions are closure-bound and may also be destructured without losing `this`.
const { pendingOperations } = queries;
const pending = await pendingOperations();
await database.close();
```

Create one bounded pool per service process and share it among that process's query collections. Migrations run explicitly using an administrative credential; runtime startup verifies migration hashes and chain/exchange/order-version identity. Atomic trading needs no nonce allocation or operational trading store: users sign and broadcast their own atomic placement. Raw integer encodings and synchronous commits remain mandatory. Cancellation/position outboxes persist exact user-signed bytes atomically; server-clock ownership tokens reject stale gateway writers. Read the [shared PostgreSQL runbook](../runbooks/shared-postgres.md) for ownership, roles, pool budgets and deployment checks. Earlier audit reports describe the earlier architecture, not the current implementation.

The indexer injects Ponder's existing read-only connection into `createIndexerQueries(db)` and passes the event's writer context to named write functions. Do not open a second PostgreSQL pool to bypass Ponder's transaction/reorg semantics. Reconciliation reads its head and grouped rows in one SELECT: all subqueries use the same committed PostgreSQL snapshot. EVM integers are cast to text before JSON aggregation, not rounded through JavaScript numbers. The service separately verifies that anchor and finality through RPC. See [PostgreSQL snapshot semantics](https://www.postgresql.org/docs/current/transaction-iso.html) and the [Ponder indexing model](https://github.com/ponder-sh/ponder).

The atomic-placement revision also removes the duplicate matcher-event journal. The September 7 storage revision removes unused indexer projections and chain-wide ERC-20 transfer indexing. Use a **new Ponder schema and replay**, following the rebuild runbook; do not alter a populated projection in place. The v2 raw-unit wire/checkpoint meaning is unchanged. `/balances/:account?token=...` still returns pinned canonical ERC-20 balances and decimals; historical transfer-delta fields now return `null`. No current UI or custody function consumes those deltas.

PostgreSQL autovacuum/autoanalyze maintains live table statistics and reclaims dead tuples. Monitor its progress and storage/connection budgets. Expired API authentication rows are pruned in bounded batches using skip-locked row selection. This does not prune operation IDs, signed transactions, reconciliation reports or reviewed evidence. User-owned legacy test files are not opened, migrated or deleted automatically.

RPC clients, upstream HTTP adapters and UI fetches stay in their runtime layers: they are not direct database access. Browser bundles must not import database/Ponder entrypoints or receive database credentials. The database package never imports an application, service or `ponder:*` runtime virtual module. Automated boundary tests enforce these rules for authored runtime code. Historical audit evidence is retained as a historical snapshot, not rewritten to resemble the current source.

## Logger

`@conditional-stocks/shared` exports a browser-safe `Logger`, `logLevel` and sanitization utilities. `@conditional-stocks/shared/http` separately exports Hono request middleware; importing the logger does not pull in Bun, Node, a database driver or Hono.

```ts
import { Logger, logLevel } from "@conditional-stocks/shared";

const logger = new Logger({ service: "api", level: logLevel(process.env.LOG_LEVEL) });
logger.info("order.accepted", { operationId, orderHash, quantity });
logger.child({ requestId }).error("operation.failed", { error });
```

Records contain `timestamp`, `level`, `service`, `event`, and structured `fields`. Big integers are decimal strings; named public transaction/order/block identities are retained. A custom synchronous `sink(record)` can forward records to an existing collector. No remote log service, credential or new telemetry destination is required. Logging/serialization failure does not fail a trade.

- `LOG_LEVEL=info` configures backend services. Valid levels: `debug`, `info`, `warn`, `error`, `silent`.
- `NEXT_PUBLIC_LOG_LEVEL=info` configures both UIs at build time. Change it and rebuild to change browser verbosity. Browser logs use the browser console; they are not uploaded automatically.
- API middleware logs every completed request at the configured threshold, including rejected requests and handled errors, with a server-generated `x-request-id`, method, matched route template, status and duration. It does not consume bodies or log arbitrary paths, URL queries or headers. UI gateway proxies preserve valid request IDs on upstream responses.
- High-frequency internal health/book/status polling is logged at debug; errors remain warning/error. Startup/shutdown, indexer milestones, atomic quote milestones, user recovery transitions, reconciliation results, and Polymarket quality changes use normal operational levels.
- Indexer `indexer.event.applied` / `indexer.progress` means the handler completed, **not** that Ponder committed/finalized the block. RPC finality and reconciliation remain the source of trading readiness.
- Reconciler logs go to stderr so its one-shot JSON report on stdout remains machine-readable. Other services use stdout for info/debug and stderr for warn/error. Existing framework logs may retain Ponder/Next's native formatting.

Sensitive fields (authorization, cookies, credentials, private keys, signatures, raw/signed transactions, bodies, payloads and environment objects) are redacted. RPC/database URLs and common credential patterns in error text are scrubbed; arbitrary RPC error properties, causes and stacks are not serialized. Nesting, arrays and strings are bounded. Do not log complete requests, wallet/provider objects or secrets disguised as public identifiers: redaction is defense in depth, not a guarantee that arbitrary unlabelled text is safe.

Keep logs private, configure collector rotation/retention and restrict access. Logs are not the custody ledger, immutable evidence store or a substitute for reconciliation. Shared database persistence does not remove internal-testing exposure limits or substitute for a measured multi-host failover/load rehearsal.

## Checks

Run `bun run check` for Biome, contract formatting/lint/build, all workspace typechecks, TypeScript tests and contract tests. `bunx biome check --write .` formats authored TypeScript and organizes imports; generated/vendor/artifact directories remain excluded by the repository configuration.

Run `bun packages/contracts/scripts/verify-internal-stack.ts --storage --production-ui` for the standalone PostgreSQL/Anvil rehearsal. It verifies GTC/IOC settlement, fail-closed outage behavior, durable restarts/reorgs/rebuilds, and both production frontend builds starting and serving against the local stack. It uses mock tokens only and sends no upstream/mainnet transactions. The frontend checks are HTTP/build smoke tests, not a substitute for wallet interaction testing in a browser. The rehearsal builds `.next-rehearsal` with local fixture settings: rebuild both Next applications with deployment environment variables before deployment.
