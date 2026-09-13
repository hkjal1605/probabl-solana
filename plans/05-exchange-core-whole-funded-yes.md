# Milestone 05 — Exchange core: whole-funded YES

## Implementation status — 2026-09-04

Implemented and integration-tested against the pinned CTF: signed GTC opening, exact escrow, canonical sequence, maker-price fills, partial accounting, immediate price improvement, cancellation, caps, callback protection, and whole/whole YES settlement. Fill materialization is isolated in the immutable exchange-only `ConditionalSettlement` so all runtime bytecode stays deployable.

## Goal

Implement the smallest complete trading path: two whole-collateral GTC orders on the YES book reserve assets, match at the resting order’s price, create conditional claims, deliver outputs, and release price improvement safely.

## Dependencies

- Milestone 02 order schema, hashes, amounts, and vectors.
- Milestone 03 CTF integration.
- Milestone 04 registered open market.

## Supported slice

- Branch: YES only.
- Funding: buyer uses whole USDG; seller uses whole Stock Token.
- Time in force: GTC only.
- Full and partial fills.
- Direct contract/CLI submission for testing; production gateway and matcher arrive later.
- Zero fees.

## Order opening

Implement `openOrder` with:

- EIP-712 signature verification and domain separation;
- registered market and `Open` state validation;
- expiry, nonce, salt, tick, step, minimum-notional, order-size, wallet, and market-cap validation;
- correct token derivation from the registry rather than caller-supplied assets;
- safe collateral transfer into per-order escrow;
- buyer reservation rounded up at `remainingQuantity * limitPrice`;
- seller reservation equal to remaining base quantity;
- monotonic per-market/branch sequence assignment;
- complete `OrderOpened` event and stored remaining/reserved/status state.

The order becomes matchable only after the onchain event exists. Client or gateway timestamps never determine queue priority.

## Cancellation

Implement maker-authorized cancellation that:

- cannot reverse filled quantity;
- releases only remaining reserved collateral;
- is replay-safe and idempotent at the API/worker layer later;
- emits enough data to rebuild the order state;
- returns canceled collateral directly to the maker wallet.

## YES fill accounting

For quantity `q` at execution price `K`:

```text
buyer:  q*K USDG -> q*K USDG_YES + q*K USDG_NO
seller: q stock -> q STOCK_YES + q STOCK_NO

buyer receives STOCK_YES and retains USDG_NO
seller receives USDG_YES and retains STOCK_NO
```

Use raw integer math. The resting order is the lower canonical sequence and sets the execution price. A bid may never pay above its limit; an ask may never receive below its limit.

## Reservation updates

- Split only the quote amount required at the execution price.
- Release bid price improvement immediately.
- After a partial fill, retain exactly the rounded-up amount needed at the bid limit for the remaining quantity.
- Reduce ask reservation by exactly the filled raw base quantity.
- Update state before external token callbacks where required by reentrancy-safe design.

## Contract safety

- `MATCHER_ROLE` may submit fills but cannot withdraw assets.
- Orders must have the same market and branch and opposite sides.
- Quantities cannot exceed either remaining amount.
- Filled/canceled/expired orders cannot be reused.
- Contract pause/freeze rejects new orders and fills but does not trap cancelable collateral.
- Token transfers use safe wrappers and callback protections.

## Tests

- Maker bid and maker ask price cases.
- Exact cross, price improvement, and non-crossing limits.
- Full and multiple partial fills.
- Reservation/dust reconciliation after every fill.
- Cancel-before-fill, cancel-after-partial-fill, cancel/fill race.
- Wrong chain/domain/signature, nonce, expiry, market, branch, side, token, tick, step, and cap.
- Replay, reentrancy, malicious token callback, and false/no-return token behavior.
- Stateful invariant: exchange-held reservation equals total open-order requirements.
- Stateful invariant: CTF claims plus unsplit escrow reconcile to deposited collateral.

## Deliverables

- Initial `ConditionalExchange` contract.
- YES whole/whole fill implementation.
- GTC open and cancellation CLI/scripts.
- Events and generated bindings.
- Unit, fuzz, and invariant suite.

## Exit criteria

- [x] A manually created market can execute a whole-funded YES trade end to end.
- [x] Execution always uses the earlier order’s price.
- [x] Partial-fill reservation and price-improvement math matches golden vectors.
- [x] Cancellation returns exactly unfilled collateral.
- [x] Matcher authority cannot seize or redirect collateral.
- [ ] Accounting invariants hold under randomized order/fill/cancel sequences.

## Non-goals

- NO orders.
- Claim-funded orders.
- IOC orders.
- Offchain matching or API services.
- Protocol fees.
