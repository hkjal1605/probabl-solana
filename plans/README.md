# Conditional Stocks v1 implementation roadmap

This directory converts the source-of-truth architecture in [`CONDITIONAL_STOCKS_IMPLEMENTATION_PLAN.md`](../CONDITIONAL_STOCKS_IMPLEMENTATION_PLAN.md) into executable milestones.

Read the source plan before implementing any milestone. If a milestone conflicts with it, the source plan wins until the conflict is resolved in an explicit architecture decision record (ADR) and both documents are updated.

## Fixed v1 boundaries

Every milestone must preserve these constraints:

- Two independent continuous CLOBs per stock/event market: YES and NO.
- Fully collateralized Stock Token asks and USDG bids; no leverage, borrowing, naked shorting, or liquidation.
- Offchain deterministic matching with onchain escrow, validation, fills, cancellation, merge, and redemption.
- Manual admin-only market creation.
- Manual admin-only market resolution based on reviewed Polymarket evidence.
- No automated resolution watcher, attestation network, bridge, state proof, or cross-chain messaging.
- No KYC/KYB, sanctions, geography, investor-status, tax-status, appropriateness, wallet-allowlist, or compliance-provider implementation.
- Standard conditional ERC-1155 claims without identity-based transfer restrictions.
- USDG is the only quote asset and protocol trading fees are zero.
- Non-upgradeable v1 contracts.

## Milestone sequence

| ID | Milestone | Depends on | Primary result |
| --- | --- | --- | --- |
| 00 | [Dependency validation](./00-dependency-validation.md) | None | Verified assumptions and blocked-dependency register |
| 01 | [Architecture and repository foundation](./01-architecture-and-repository-foundation.md) | 00 | ADRs, monorepo, CI, environments |
| 02 | [Domain schemas and golden vectors](./02-domain-schemas-and-golden-vectors.md) | 01 | Shared order, market, hashing, and math specification |
| 03 | [Conditional Tokens and mock assets](./03-conditional-tokens-and-mock-assets.md) | 02 | Tested split/merge/redeem collateral primitive |
| 04 | [Market registry](./04-market-registry.md) | 02–03 | Manual admin market creation and immutable market lifecycle |
| 05 | [Exchange core: whole-funded YES](./05-exchange-core-whole-funded-yes.md) | 02–04 | Escrowed GTC orders, cancellation, and first fill path |
| 06 | [Complete exchange funding and order paths](./06-complete-exchange-funding-and-orders.md) | 05 | NO branch, claim funding, partial fills, IOC |
| 07 | [Position lifecycle and pause safety](./07-position-lifecycle-and-pause-safety.md) | 06 | Merge, redemption, expiry, freeze, and withdrawal guarantees |
| 08 | [Manual admin resolution](./08-manual-admin-resolution.md) | 03–04, 07 | Admin-only one-time resolution and evidence trail |
| 09 | [Deterministic order-book matcher](./09-deterministic-orderbook-matcher.md) | 02, 05–06 | Replayable price-time-priority matching engine |
| 10 | [Chain indexer and reconciliation](./10-chain-indexer-and-reconciliation.md) | 04–09 | Canonical projections and accounting checks |
| 11 | [Order gateway and settlement worker](./11-order-gateway-and-settlement-worker.md) | 09–10 | Validated order intake and reliable fill submission |
| 12 | [Polymarket data and admin evidence workflow](./12-polymarket-data-and-admin-evidence.md) | 04, 08, 10 | Display-only probability and manual resolution evidence flow |
| 13 | [Web, portfolio, and admin applications](./13-web-portfolio-and-admin-applications.md) | 10–12 | Complete user and operator workflows |
| 14 | [Operations, security, and testnet readiness](./14-operations-security-and-testnet-readiness.md) | 03–13 | Hardened, observable, audited release candidate |
| 15 | [Capped mainnet pilot](./15-capped-mainnet-pilot.md) | 14 | Controlled v1 launch and three resolved cycles |

Milestones are sequential at their dependency boundaries, but independent work inside a milestone may proceed in parallel. A later milestone must not invent a second definition of hashes, units, market state, or payouts.

## Global definition of done

A milestone is complete only when:

1. Its required artifacts are committed and documented.
2. Automated tests pass from a clean checkout.
3. Contract and TypeScript behavior match the shared golden vectors where applicable.
4. Events and persisted data are sufficient for deterministic replay and audit.
5. Failure behavior and operational ownership are documented.
6. No v1 non-goal has been introduced accidentally.
7. The milestone exit checklist is completed with evidence links or command output.

## Working conventions

- Use raw integer token units and `priceX18`; never use floating point for accounting.
- The Robinhood Chain event log is canonical for local orders, fills, balances, and resolution.
- PostgreSQL, Redis, APIs, and UIs are projections—not custody ledgers.
- Use one shared domain package for schemas, hashes, amount math, and state names.
- Pin contract dependencies and record deployed bytecode, compiler settings, chain IDs, addresses, and deployment blocks.
- Every state-changing API and worker action must be idempotent.
- Pausing or freezing must never prevent cancellation, release of unfilled collateral, merging, or redemption.
- “User cap” means wallet cap in v1 and is not Sybil-resistant. Market-wide caps are the dependable risk control.

## Progress tracking

Each milestone document contains an exit checklist. Mark an item complete only when its evidence exists. Keep status in this table rather than creating competing roadmaps.

| Milestone | Status | Evidence |
| --- | --- | --- |
| 00 | In progress | Official chain IDs/RPCs checked; exact USDG/Stock Token compatibility and production addresses remain testnet gates |
| 01 | Implemented; fresh CI gate pending | Bun/Hono/Biome/Foundry scaffold, CI, ADRs, config, bindings, manifest schema |
| 02 | Implemented | Shared Solidity/TypeScript schema and cross-language golden-vector tests |
| 03 | Implemented; production-token gate pending | Pinned Gnosis artifact integration, mock failures, split/merge/redeem and conservation fuzz tests |
| 04 | Implemented; audit pending | `MarketRegistry`, manual creation CLI, terms template, lifecycle tests |
| 05 | Implemented; audit pending | Whole-funded YES escrow/fill/cancel path and accounting tests |
| 06 | Implemented; audit pending | Both branches, all funding pairs, bounded atomic IOC, gas snapshot |
| 07 | Implemented; audit pending | Position/recovery routers, pause matrix, direct recovery runbook |
| 08 | Implemented; multisig rehearsal/audit pending | Manual controller, simulation-first CLI, evidence runbook, payout tests |
| 09 | Implemented; independent review/integration pending | Deterministic core, slow shadow, golden/randomized tests, fencing, SQLite journal/checkpoints, crash/reorg recovery |
| 10 | Implemented; production RPC/load validation pending | Ponder projections/API, confirmed matcher feed, Anvil reorg/replay/trade/resolution validation, continuous/deep reconciliation and freeze signals |
| 11 | Implemented; production fee/load/security review pending | Authenticated/idempotent gateway, exact previews/validation, matcher-only durable worker, Ponder confirmations, fault tests, Anvil GTC/IOC/cancel/redeem E2E, YES/NO/invalid Foundry lifecycles |
| 12 | Implemented; production data-rights/load and multisig rehearsal pending | Strict mapping and YES-book adapter, append-only ingestor/evidence stores, two-person admin workflow, exact Safe previews, public APIs, fault tests, and Anvil manual creation/resolution E2E |
| 13 | Implemented; production browser/a11y and testnet rehearsal pending | Next.js 16 public/admin apps, shared UI kit, exact order math, ABI-verified user-paid fallback, canonical projections, manual admin workflows, production builds, unit tests, and browser QA |
| 14 | Not started | — |
| 15 | Not started | — |
