# Permissionless atomic placement

Status: implemented. See the [verification report](../../audit/2026-09-08/atomic-placement/REPORT.md)
for executed tests, coverage gaps, and residual risks. This is not an independent
production audit approval.

**Checked-execution v2 update:** [atomic hardening](atomic-hardening.md) supersedes
the execution-v1 limitations below. The first-party path now calls
`placeAndMatchChecked`, binds the book admission sequence and exact fee rates,
revalidates best price/FIFO before returning wallet calldata, checks final resting
caps, and can release up to 32 stale reservations. Failed payouts are isolated in
the beneficiary-only `PayoutVault`. External callers can still use the unrestricted
entry point; neither entry point proves global best price onchain.

## Execution contract

The user's wallet calls `AtomicOrderRouter.placeAndMatch`. The router accepts only
the order owner's call (including an ERC-1271 wallet executing its own call), not
an arbitrary relayer holding a leaked order signature. It validates the owner's
execution deadline (exclusive and no later than the signed order expiry), opens the signed order through the permanently configured
exchange, and settles a bounded list of funded resting GTC orders. The entire
placement reverts if any leg fails, including a changed quoted maker remainder.
GTC leaves its unfilled escrow resting; IOC releases its entire unfilled escrow.

The submitted calldata binds the exact maker list, quantities, expected maker
remainders, and deadline. Every fill uses the existing raw-unit accounting,
received-claim fee caps, and earlier-order execution price. An order is taker on
placement and maker when a later order consumes its resting remainder. There is
no protocol matcher key or background settlement transaction. Execution protection
is bound by the owner's transaction calldata. Token approvals are still separate
unless already granted.

## Candidate discovery

The API reads a bounded price/FIFO-ordered book from the canonical indexer through
query functions in `packages/db`. It excludes expired, nonce-invalidated, and
fee-ineligible makers and plans opposite-side fills in the same market/branch.
It verifies deployment identity and block context, validates funding and signed
orders, and simulates the complete transaction before returning execution data.
The UI reconstructs and validates the transaction locally before the user's
wallet broadcasts it. API failures must not silently fall back to rest-only
placement or server-paid settlement.

The API issues quotes valid for at most 60 seconds, bounded by the incoming order's expiry.
The UI requires a refresh after expiry. This API quote policy is stricter than
the contract's owner-chosen deadline; it is not a liquidity reservation.

The candidate list is advisory: contracts enforce trade validity, not global
best-price/FIFO or completeness. Quotes cannot reserve liquidity offchain. A
changed maker remainder, cancellation, expiry, fee change beyond a cap, or
reorganization can make execution revert; the user then requests a new quote.
Reverted calls return escrow changes atomically but still consume gas. Oversized
sweeps must be rejected explicitly rather than silently resting a crossing GTC
remainder after exhausting the candidate budget. New orders arriving after the
snapshot may still be omitted; no claim of automatic complete book clearing is
made. In particular, concurrent quotes can leave crossed resting orders. There
is no resting-versus-resting background sweep; a subsequent incoming order may
consume them, or an owner can cancel and re-place. This is an intentional liveness
tradeoff of removing the matcher, not contract-enforced best execution.

The indexer separately accumulates executed base units in `protocol_order.filled`.
Cancellation clears the live `remaining` and reservation fields, but must never
inflate the historical filled quantity. Both the UI and demo use that executed
quantity. The extra scalar is maintained in the existing per-fill order update,
with no added database round trip. Replay Ponder into a fresh projection schema
when adopting this schema change; do not mutate a running projection in place.

## Work and verification checklist

- [x] Router/exchange authorization and atomic GTC/IOC implementation.
- [x] Price/FIFO candidate planner and bounded indexed database queries.
- [x] API preparation/simulation and wallet-paid UI execution (including demo parity).
- [x] Indexing, accounting, reconciliation, configuration, and deployment wiring.
- [x] Contract unit/fuzz/invariant and adversarial receiver coverage.
- [x] Planner/API/UI/database tests and local full-stack lifecycle verification.
- [x] Delete obsolete matcher/settlement services, journals, queues, and configuration.
- [x] Build/typecheck/formatting/security review and verification report.

These items describe implementation and performed verification, not a claim of
100% whole-service coverage or exhaustive proof over every possible execution.

Historical audit evidence and already-applied migrations are retained as history;
obsolete runtime components are removed, not deployed alongside this design.
