# ADR-008 — Robinhood Chain events are canonical

Status: Accepted

## Context

Gateway, matcher, and database timestamps can disagree or be manipulated.

## Decision

Confirmed Robinhood Chain contract state and events define accepted orders, sequence priority, fills, cancellations, lifecycle, and payouts. Offchain stores are rebuildable projections.

## Alternatives

Database-assigned priority, client timestamps, and operator-signed receipts were rejected as canonical sources.

## Consequences

Orders enter the book only after confirmation and reorg handling. Events must remain complete and versioned.

## Security assumptions

Indexer finality policy matches Robinhood Chain behavior and reconciliation detects missed/reorganized logs.

## Reversal cost

Changing canonical ordering would invalidate matcher assumptions and requires a new exchange/version.
