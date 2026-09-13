# ADR-002 — Conditional claims and in-kind settlement

Status: Accepted

## Context

Promises to exchange assets later would require credit, margin, liquidation, and price oracles.

## Decision

Use the pinned Gnosis Conditional Tokens implementation. Whole Stock Token or USDG collateral is split into binary ERC-1155 claims at fill time; winning claims redeem in kind.

## Alternatives

Cash settlement, proprietary ledgers, wrappers, margin, and unsecured obligations were rejected.

## Consequences

Every position is fully collateralized, while users must handle ERC-1155 approvals and token-specific behavior.

## Security assumptions

The exact CTF deployment and collateral tokens behave as tested. Raw collateral conservation is more important than display multipliers.

## Reversal cost

Changing the claim primitive requires new markets and contracts. Existing conditions must continue using their original CTF deployment.
