# probabl

Database deployment: follow the [shared PostgreSQL runbook](./docs/runbooks/shared-postgres.md).
All services now require the same PostgreSQL database; local embedded stores are unsupported.
Migration verification and test-coverage progress are tracked in the [implementation record](./docs/architecture/shared-postgres-migration.md).

Public UI hosting: use the [Cloudflare Workers deployment runbook](./docs/runbooks/ui-cloudflare-workers.md)
for `apps/ui`, including build/runtime settings, local runtime checks and deployment commands.

Conditional Stocks is a fully collateralized event-conditional Stock Token exchange for Robinhood Chain. See [`CONDITIONAL_STOCKS_IMPLEMENTATION_PLAN.md`](./CONDITIONAL_STOCKS_IMPLEMENTATION_PLAN.md) for the product architecture and [`plans/README.md`](./plans/README.md) for the delivery roadmap.

Execution now uses [permissionless atomic placement](./docs/architecture/atomic-placement.md): the API selects candidates and the user's wallet opens and settles the order in one transaction. There is no protocol-owned matcher or settlement broadcaster. [Checked execution v2](./docs/architecture/atomic-hardening.md) adds deferred-payout recovery, final-state caps and stale-order cleanup. See the [current hardening report](./audit/2026-09-08/atomic-hardening/REPORT.md) for evidence and limitations.

The current pricing and migration specification is [`raw-unit ratio v2`](./docs/architecture/raw-unit-ratio-v2.md), alongside the core lifecycle architecture in [`protocol-v1.md`](./docs/architecture/protocol-v1.md). Production boundaries and explicit trust assumptions are in [`SECURITY.md`](./SECURITY.md).

The [v2 security re-audit and real-token verification report](./audit/2026-09-06/raw-unit-ratio/REPORT.md) records the implemented migration, test evidence and remaining M-02 production blocker.

For the owner-approved supervised internal mainnet experiment, use the [internal readiness report](./audit/2026-09-07/internal-mainnet-readiness/REPORT.md) and [deployment/environment runbook](./docs/runbooks/internal-mainnet-testing.md). The complete local PostgreSQL/service/browser rehearsal passed; actual hosted infrastructure, archive RPC and funded RH acceptance remain pending. M-02 and the dependency advisories are deferred for this experiment, not resolved or approved for public production.

## Toolchain

- Bun workspaces and runtime for TypeScript.
- Hono for the API.
- Biome for TypeScript/JSON formatting and linting.
- Foundry for Solidity builds and tests.

Solidity contracts are the necessary exception to the TypeScript-only application-code rule.

## Commands

```bash
bun install
bun run dev:api
bun run dev:ui
bun run dev:admin-ui
bun run typecheck
bun run lint
bun run test
bun run build
bun run generate:bindings
bun run anvil:indexer
bun run anvil:indexer:bootstrap
bun run dev:indexer:anvil
bun run reconcile:indexer:anvil
bun run dev:api:anvil
bun run dev:polymarket:anvil
bun run e2e:milestone12:anvil
```

`bun run check` runs Biome, Forge formatting/lint, TypeScript checks, Bun tests, and the Solidity suite. `bun run build:contracts` also enforces the EVM runtime-size limit. Run `bun run audit:deps` separately because it requires registry network access.

## Workspace

```text
apps/api             Hono API
apps/ui              Next.js 16 public trading, portfolio, and resolution interface
apps/admin-ui        Next.js 16 manual operator and evidence interface
packages/config      Validated runtime configuration
packages/db          Central schemas, transactional queries and indexer projections
packages/shared      Browser/backend structured logger and request middleware
packages/domain      Shared hashes, schemas, and integer math
packages/gateway     Shared order parsing, validation, funding, and payoff previews
packages/orderbook   Stateless bounded price/FIFO atomic-plan selection
packages/market-data Strict Polymarket normalization, YES book, and evidence hashing
packages/contracts   Non-upgradeable Solidity protocol
packages/contract-bindings  Reproducibly generated TypeScript ABIs
packages/ui           Shared design tokens and shadcn-style interface primitives
services/rh-indexer   Ponder projections, canonical match candidates, reconciliation
services/polymarket-ingestor Display-only metadata/probability ingestion and alerts
```

The v1 UI applications are documented in [`docs/architecture/web-admin-ux-v1.md`](./docs/architecture/web-admin-ux-v1.md). KYC/compliance services and automated cross-chain resolution remain intentionally absent from v1; market creation and resolution are manual admin-only workflows.

Database ownership, query functions, log events and verbosity settings are documented in [`database-and-logging.md`](./docs/architecture/database-and-logging.md).

The contracts are implementation-complete for the documented core milestone, but they are not production-approved until independent audits, Robinhood testnet validation, exact production token verification, and multisig/runbook rehearsals are complete. No unaudited smart-contract system can honestly guarantee zero exploitable defects.
