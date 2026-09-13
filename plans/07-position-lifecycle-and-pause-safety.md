# Milestone 07 — Position lifecycle and pause safety

## Implementation status — 2026-09-04

`PositionRouter`, direct CTF recovery tests, maker cancellation, nonce invalidation, permissionless expiry/closed-market release, and a 64-entry best-effort `OrderRecoveryRouter` are implemented. The global pause blocks only opens/fills; cancellation, merge, and redemption remain live. The direct-recovery runbook documents application-independent use.

## Goal

Ensure users can safely exit, merge, redeem, cancel, and recover unfilled assets throughout normal operation, market freeze, service outage, and protocol pause.

## Dependencies

- Milestone 06 complete exchange paths.

## Position operations

Implement or integrate:

- `mergeForUser(marketId, collateral, amount, recipient)`;
- `redeemForUser(marketId, collateral, indexSets, recipient)`;
- direct permissionless CTF merge/redeem documentation and tests;
- batch helpers for stock and USDG claims;
- balance queries that distinguish whole assets, active claims, inactive claims, and reserved claims.

Helpers must never become the only redemption route. Users must remain able to redeem directly through Conditional Tokens if the application or exchange is unavailable.

## Order recovery

- Implement `cancelUpTo(newMinimumNonce)` for emergency bulk invalidation.
- Implement permissionless `releaseExpiredOrder(orderHash)` with funds returned only to the maker/recipient allowed by the order.
- Make frozen-market reservations releasable in bounded batches and individually by users.
- Specify behavior for pending settlement transactions during a freeze.
- Ensure repeated cancellation/release calls are safe and deterministic.

## Pause model

Define separate controls where needed for:

- opening new orders;
- submitting new fills;
- market-specific freeze;
- protocol-wide incident pause.

No pause may block:

- cancellation of unfilled quantities;
- release of expired/frozen reservations;
- withdrawal of unreserved assets;
- merging complete claim sets;
- redemption after resolution.

The guardian cannot transfer assets, edit market terms, or report payouts.

## Auto-merge preparation

Define a read-only algorithm for later services/UI to identify mergeable complete sets after subtracting reservations. Auto-merge execution must be opt-in or clearly authorized by the user’s smart wallet and must never consume a reserved claim.

## Tests

- Merge/redeem for stock and USDG after YES, NO, and invalid outcomes.
- Merge before resolution and rejection of invalid or unequal sets.
- Direct CTF redemption with the web/API/exchange absent.
- Partial order plus nonce cancellation.
- Expiry release by maker and third party.
- Freeze with many open orders and bounded releases.
- Pause matrix proving every recovery operation remains live.
- Concurrent fill/cancel/freeze/release race tests.
- Reentrancy tests around merge, redeem, and ERC-1155 receipt.
- Invariant: no pause state increases administrator control over user assets.

## Deliverables

- Merge/redeem and batch-helper contracts/interfaces.
- Nonce invalidation and expiry/freeze release paths.
- Pause/freeze permissions matrix.
- Direct recovery user runbook.
- Stateful tests for every lifecycle state.

## Exit criteria

- [x] Users can recover all unfilled assets without operator discretion.
- [x] Complete sets merge correctly before resolution.
- [x] Winning and invalid claims redeem correctly after resolution.
- [x] Direct CTF redemption works without application services.
- [x] Every pause/freeze state preserves cancellation, merge, and redemption guarantees.
- [x] Large frozen books can be released without an unbounded transaction.

## Non-goals

- Automatic resolution.
- Automated custody or discretionary account management.
- Cross-market portfolio optimization.
- A privileged asset-recovery backdoor.
