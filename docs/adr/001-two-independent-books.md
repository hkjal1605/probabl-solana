# ADR-001 — Two independent conditional books

Status: Accepted

## Context

The product needs executable stock-if-YES and stock-if-NO prices, not another event-probability market.

## Decision

Each stock/event market has independent `STOCK_YES/USDG_YES` and `STOCK_NO/USDG_NO` continuous CLOBs. The protocol does not force an arithmetic relationship between them.

## Alternatives

One coupled book, an AMM, a batch auction, and a local prediction market were rejected for v1.

## Consequences

Liquidity fragments across two books, but prices remain legible and independently executable.

## Security assumptions

The authorized matcher may choose among submitted orders only within their signed limits; global best execution remains auditable offchain.

## Reversal cost

A different market mechanism requires new order schemas, contracts, services, and a new protocol version. Existing claims remain redeemable.
