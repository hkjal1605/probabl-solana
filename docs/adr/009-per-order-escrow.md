# ADR-009 — Per-order escrow

Status: Accepted

## Context

A general account ledger increases custody, withdrawal, and attribution complexity.

## Decision

Every open order has a stored remaining quantity, exact reservation, funding kind, and maker. Whole collateral or active claims move into `ConditionalExchange`; filled outputs and price improvement go directly to wallets; cancellation returns only that order's remainder.

## Alternatives

Internal deposit balances, portfolio margin, pooled custody, and offchain reservation were rejected.

## Consequences

Opening orders costs token transfers, but escrow is chain-auditable and recovery does not require operator discretion.

## Security assumptions

Aggregate contract balances reconcile to live reservations; settlement is permanently bound and has no arbitrary withdrawal function.

## Reversal cost

A general ledger would require migration deposits and a new custody threat model.
