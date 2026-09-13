# ADR-007 — Raw-unit accounting and deterministic rounding

Status: Accepted

## Context

Stock Token multipliers and decimal formatting can diverge across clients; floating point is unsafe for settlement.

## Decision

Historical v1 accepted only 18-decimal collateral. That restriction and its whole-token price interpretation are superseded by [v2 raw-unit-ratio accounting](../architecture/raw-unit-ratio-v2.md). V2 accounts in raw integers, expresses price as `priceRawX18` (raw quote/raw base scaled by `1e18`), uses full-precision `mulDiv`, rounds bid reservation up, and rounds execution quote down. Token decimals and stock multipliers are offchain metadata, not balance mutations.

## Alternatives

Floating point, arbitrary decimals, rebased internal balances, and oracle-normalized settlement were rejected.

## Consequences

UI and services must use the shared bigint package and disclose at most one quote-unit rounding difference.

## Security assumptions

Registered tokens truthfully report decimals and preserve raw transfers apart from explicitly rejected unsupported mechanics.

## Reversal cost

New decimals or accounting semantics require new schemas, vectors, and contracts.
