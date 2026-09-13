# ADR-004 — Manual market creation

Status: Accepted

## Context

Incorrect event IDs, outcome orientation, collateral, or cutoff terms can irreversibly harm a market.

## Decision

Only `MARKET_ADMIN_ROLE` may create and open curated markets after a documented four-eyes review. Terms and Polymarket mapping are immutable. The registry is permanently locked to its deployment-time USDG address.

## Alternatives

Permissionless listings, API-triggered creation, scheduled automatic creation, and editable market terms were rejected.

## Consequences

Listings are slower and centralized but have an explicit evidence trail and bounded scope.

## Security assumptions

The market-admin multisig follows the review process. The contract validates structure, not the real-world correctness of the mapping.

## Reversal cost

Permissionless listing requires a new registry/version. Filled v1 markets cannot be remapped.
