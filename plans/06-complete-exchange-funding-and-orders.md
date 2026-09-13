# Milestone 06 — Complete exchange funding and order paths

## Implementation status — 2026-09-04

YES and NO, all four whole/active-claim funding combinations, GTC, and bounded IOC are implemented. `IOCRouter` caps makers at 32 and atomically opens, fills, and cancels the taker remainder. Maker-list failures revert the IOC; the production matcher must simulate and remove stale entries. Tests cover symmetry, mixed funding, dust, slippage/maker price, and randomized partial reservations.

## Goal

Complete the v1 exchange state machine by adding the NO book, active-claim funding, every funding combination, protected IOC orders, and production-grade batch constraints.

## Dependencies

- Milestone 05 whole-funded YES exchange core.

## Branch symmetry

Implement NO orders using the same validation and reservation machinery as YES. Avoid copy-pasted accounting paths: branch selection should derive active/inactive position IDs from the registry and shared domain definitions.

For a whole/whole NO fill at `q` and `K`:

```text
buyer receives:  q STOCK_NO + q*K USDG_YES
seller receives: q*K USDG_NO + q STOCK_YES
```

If NO resolves, stock goes to the buyer and cash to the seller. If YES resolves, each side recovers its original whole collateral through the inactive claims.

## Funding combinations

Support and test, for both branches:

1. whole USDG bid matched with whole Stock Token ask;
2. whole USDG bid matched with active stock-claim ask;
3. active USDG-claim bid matched with whole Stock Token ask;
4. active USDG-claim bid matched with active stock-claim ask.

Rules:

- Split only a filled amount of whole collateral.
- Debit active claims directly without an unnecessary split.
- Return newly created inactive claims only to the party whose whole collateral was split.
- Transfer active stock claims to the buyer and active USDG claims to the seller.
- Keep each signed order single-source. Mixed user funding is represented by two linked orders at the gateway layer.

## Claim reservations

- Active-claim bids reserve the active USDG amount needed at the limit.
- Active-claim asks reserve active Stock Token claims equal to base quantity.
- Validate ERC-1155 operator approval and receiver safety.
- Never reserve or spend inactive-branch claims for an active-branch order.
- Preserve per-order attribution for every ERC-1155 amount held by the exchange.

## IOC and protected market orders

Implement `executeIOC` as one atomic call containing:

- a signed taker order with explicit quantity and worst acceptable price;
- an ordered list of already-open makers;
- fill quantities bounded by both orders;
- reservation, fills, and remainder release in the same transaction.

There is no unbounded market order. Reject FOK, post-only, reduce-only, stop, and iceberg semantics in v1.

The contract validates each maker and the maker price but does not prove that the submitted list contains the globally best available orders. Fair ordering is enforced and audited by the matcher in milestone 09.

## Batch and gas behavior

- Cap makers/fills and maximum gas per call.
- Decide and document atomic versus isolated failure behavior.
- Ensure one expired/canceled maker cannot indefinitely block a book.
- Emit one fill record per maker plus one taker completion/remainder record as needed for replay.
- Preserve deterministic fill IDs and quantities across simulation and submission.

## Tests

- YES and NO for all four funding combinations.
- Linked whole-funded and claim-funded child orders at the same price across partial fills.
- ERC-1155 approval, receiver, and callback failures.
- IOC across several price levels, partial IOC, empty IOC, slippage boundary, and remainder release.
- Same-price sequence ordering and maker-price calculation.
- Batch maximums and denial-of-service cases.
- Wrong branch/position IDs and attempts to substitute arbitrary tokens.
- Invariant: fee charged is exactly zero.
- Invariant: all escrowed ERC-20 and ERC-1155 balances map to live order reservations.

## Deliverables

- Complete v1 exchange branch/funding implementation.
- Atomic protected IOC implementation.
- Shared fill-accounting library with golden vectors.
- Gas report and batch-size recommendation.
- Complete events and generated bindings.

## Exit criteria

- [x] YES and NO behave symmetrically for all funding combinations.
- [x] Whole collateral is split only for filled amounts.
- [x] Inactive claims always return to the correct original funder.
- [x] IOC never executes outside quantity or price protection and releases its remainder atomically.
- [x] Every exchange balance reconciles to an open order or a documented transient operation.
- [ ] Randomized tests cover mixed funding, partial fills, cancellations, and IOC batches.

## Non-goals

- Margin, credit, or cross-market netting.
- RFQ, AMM, auction, or future order types.
- Permissionless fill submission.
- Offchain user portfolio projections.
