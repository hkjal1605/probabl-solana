# Milestone 01 — Architecture and repository foundation

## Implementation status — 2026-09-04

Implemented in this repository: Bun workspaces, Hono API shell, strict TypeScript, Biome, Foundry, pinned dependencies, CI, validated runtime configuration, generated TypeScript ABIs, deployment-manifest schema, and all ten ADRs. UI and later service workspaces remain intentionally uncreated. A fresh-checkout CI run is still required before this milestone is operationally closed.

## Goal

Create the repository, decision records, toolchain, and continuous-integration foundation on which every v1 component will rely.

## Dependencies

- Milestone 00 dependency matrix is complete enough to choose supported development environments.

## Repository structure

Create directories when their milestone begins; do not scaffold empty UI or service packages prematurely. The planned end-state layout is:

```text
apps/web
apps/admin
apps/api
services/matcher
services/settlement-worker
services/rh-indexer
services/polymarket-ingestor
packages/contracts
packages/contract-bindings
packages/domain
packages/orderbook
packages/market-data
packages/ui
packages/config
infra/environments
infra/monitoring
infra/runbooks
docs/architecture
docs/adr
docs/market-terms
```

Do not create a resolution-watcher service or a KYC/compliance service.

## Required ADRs

Write and approve ADRs for:

1. Two independent continuous CLOBs per stock/event market.
2. Fully collateralized CTF claims and in-kind settlement.
3. Offchain deterministic matcher with onchain escrow and fill enforcement.
4. Manual admin-only market creation.
5. Manual admin-only resolution and the absence of cross-chain settlement automation.
6. Non-upgradeable v1 contracts and migration-by-new-version.
7. Raw-unit accounting, Stock Token multipliers, and `priceX18` rounding.
8. Robinhood Chain events as the canonical local state source.
9. Per-order escrow rather than a general custodial account ledger.
10. No KYC or identity-based transfer controls in v1.

Each ADR must contain context, decision, alternatives, consequences, security assumptions, and reversal/migration cost.

## Toolchain

- Configure the TypeScript workspace, formatting, linting, type checking, unit-test runner, and build orchestration.
- Configure Foundry with pinned Solidity compiler and optimizer settings.
- Pin OpenZeppelin and Conditional Tokens dependencies by exact commit/version.
- Configure generated ABI/type bindings from contract artifacts.
- Add environment schemas that reject missing or malformed chain IDs, addresses, RPC URLs, and deployment blocks.
- Ensure secrets are never committed and production values are not copied into test fixtures.

## Continuous integration

CI must run:

- formatting and lint checks;
- TypeScript type checking;
- TypeScript unit tests;
- Solidity build and unit tests;
- Solidity fuzz/invariant tests with a bounded CI profile;
- golden-vector compatibility tests;
- dependency/license and secret scanning;
- artifact reproducibility checks where practical.

## Deliverables

- Compilable monorepo skeleton.
- Approved ADR set.
- Root development commands and contribution guide.
- CI workflow and local equivalents.
- Environment/config schema with local, Robinhood testnet, and future mainnet profiles.
- Placeholder deployment manifest format containing chain, address, bytecode hash, compiler settings, transaction, block, and admin roles.

## Exit criteria

- [ ] A clean checkout installs, builds, lints, type-checks, and tests with documented commands.
- [x] All required ADRs are approved and match the source plan.
- [x] Contract bindings can be generated reproducibly from compiled artifacts.
- [x] Configuration rejects unverified or wrong-network deployments.
- [x] No KYC or automated cross-chain resolution component exists in the repository layout.
- [x] CI protects generated artifacts, secrets, and lockfile consistency.

## Non-goals

- Production business logic.
- UI design.
- Live token deployment.
- Microservice deployment before component boundaries stabilize.
