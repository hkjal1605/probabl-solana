# Milestone 09 — Deterministic order-book matcher

Status: Implemented; independent review and full indexer/settlement integration pending.

## Goal

Build a replayable, auditable offchain matcher that maintains one price-time-priority book per `(marketId, branch)` and proposes only contract-valid fills.

## Dependencies

- Milestone 02 domain schemas and vectors.
- Milestones 05–06 exchange events and rules.

## Inputs and authority

The matcher consumes confirmed Robinhood Chain events:

- `OrderOpened`;
- `OrderCancelled`;
- `OrderFilled`;
- market state changes;
- expiry/frozen-order releases.

It also consumes `MarketTermsConfigured` (including price tick and base step), `NonceInvalidated`,
and `EmergencyPauseChanged`. These inputs are required to avoid proposing fills after cutoff,
against invalidated nonces, or during the exchange-wide pause. IOC opens advance canonical sequence
but never rest in the GTC book. A per-book sequence gap halts ingestion until the missing event is
backfilled.

Chain sequence is the only queue-time authority. API arrival time, Redis insertion time, and client timestamp are never priority inputs.

## State model

Partition processing by `(marketId, branch)` and use:

```text
bids: price-descending levels -> FIFO by canonical sequence
asks: price-ascending levels -> FIFO by canonical sequence
ordersByHash: remaining, status, reservation, sequence, pending quantity
```

All quantities and prices are integers. State must rebuild from genesis/deployment events plus an independently verified checkpoint.

## Match algorithm

```text
while bestBid.price >= bestAsk.price:
  maker = earlier canonical sequence
  taker = the other order
  executionPrice = maker.limitPrice
  fillQuantity = min(available bid quantity, available ask quantity)
  persist deterministic proposal
  mark proposed quantity pending settlement
  stop reusing pending quantity until receipt reconciliation
```

Define deterministic behavior for batch boundaries, transaction gas limits, equal timestamps, partial settlement, reverted transactions, cancellations during pending settlement, and replay after process failure.

## Fairness records

For each proposal persist:

- input event cursor and engine version;
- pre-match best bid/ask and price-level queues;
- chosen maker/taker and canonical sequences;
- execution price and quantity;
- batch ID and ordered fills;
- simulation result, submitted transaction, and final receipt;
- reason when a crossing order is skipped or delayed.

Run an independent shadow matcher from the same inputs and alert on any divergence.

## Reliability

- One active lease per book with fencing tokens.
- Hot standby capable of replaying from a checkpoint.
- Persist proposals before broadcast.
- Do not mark fills final until confirmed chain events arrive.
- Rewind to a common block after a reorg and replay deterministically.
- Backpressure when settlement lags; do not create overlapping proposals for the same quantity.

## Tests

- Golden price-time vectors for maker bid and maker ask.
- Multiple price levels, same-price FIFO, partial fills, and many-to-one fills.
- YES/NO and every funding kind without special matching behavior.
- Cancellation/expiry/freeze before and during pending settlement.
- Crash at every persist/submit/receipt boundary and deterministic recovery.
- Reorg rewind and replay.
- Randomized comparison with a slow reference matcher.
- Properties: no worse-than-limit proposal, no overfill, no same-price queue jump, deterministic output for identical input.
- Shadow-matcher divergence injection and alert verification.

## Deliverables

- [x] `packages/orderbook` pure deterministic library.
- [x] `services/matcher` event-driven process boundary.
- [x] Independent flat-array reference matcher and JSON golden fixtures.
- [x] Keccak-verified checkpoint and replay format.
- [x] Durable proposal/fairness schema, SQLite adapter, fencing, and operational metrics.

Implementation and research rationale are documented in
[`docs/architecture/orderbook-matcher-v1.md`](../docs/architecture/orderbook-matcher-v1.md) and
[`ADR-011`](../docs/adr/011-typescript-matcher-v1.md).

## Exit criteria

- [x] Identical ordered events always produce identical proposals and book hashes.
- [x] Price-time priority matches the contract/domain vectors.
- [x] Pending quantities cannot be proposed twice.
- [x] Crash and reorg recovery converge to canonical chain state in the milestone fault harness.
- [x] Shadow matcher detects injected divergence and halts proposal creation.
- [x] Matcher possesses no withdrawal or market-resolution authority.

## Non-goals

- Proving global best execution onchain.
- High-frequency co-location guarantees.
- Multiple competing matchers or permissionless filling.
- Matching across YES/NO books or different markets.
