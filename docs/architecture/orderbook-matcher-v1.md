# Order-book matcher v1

> Historical design record, superseded for trading execution on 2026-09-08 by [permissionless atomic placement](./atomic-placement.md). The matcher and settlement-worker runtime code, trading queues and nonce allocator have been removed. Do not use the old startup commands or trading endpoints below.

## Scope

The matcher maintains one independent price-time-priority book for each `(marketId, branch)`. It
only consumes canonical confirmed Robinhood Chain inputs and only emits settlement proposals. It
has no withdrawal, market-creation, market-resolution, or cross-chain authority.

`packages/orderbook` is the pure state machine. `services/matcher` adds journaling, fencing,
checkpoints, crash/reorg recovery, fairness records, shadow comparison, and an async event runner.
Transaction construction and broadcast remain milestone 11 responsibilities.

## Research basis

The implementation was informed by primary-source code and documentation from established open
source engines:

- [exchange-core](https://github.com/exchange-core/exchange-core) demonstrates integer-only,
  deterministic in-memory matching, event journals/snapshots, symbol sharding, and the value of
  keeping both a simple and optimized implementation. Its published latency numbers explicitly
  exclude network and journaling work, so they are not used as a comparison target here.
- [Liquibook's order book](https://github.com/enewhuis/liquibook/blob/master/src/book/order_book.h)
  uses price-ordered containers and tracked orders with explicit callbacks. Its separation of price
  ordering from order lifecycle informed the price-level/lookup split.
- [OpenBook v2's `BookSide`](https://github.com/openbook-dex/openbook-v2/blob/master/programs/openbook-v2/src/state/orderbook/bookside.rs)
  and [order tree](https://github.com/openbook-dex/openbook-v2/blob/master/programs/openbook-v2/src/state/orderbook/ordertree.rs)
  show deterministic bid-descending/ask-ascending iteration and handle-based removal. Its fixed-size
  zero-copy representation is specific to Solana accounts and was not copied into the offchain
  service.
- [NautilusTrader's ladder](https://github.com/nautechsystems/nautilus_trader/blob/develop/crates/model/src/orderbook/ladder.rs)
  separates book, ladder, and level responsibilities in a Rust core. It remains a useful migration
  reference if profiling later justifies Rust.
- Bun's [Workers documentation](https://bun.sh/docs/runtime/workers) currently labels the API
  experimental. V1 therefore scales by partitioning books across fenced OS processes instead of
  relying on worker threads. Bun's [test runner](https://bun.sh/docs/test) supplies the deterministic
  and randomized test harness.

No source code was copied from these projects. Their designs were used to challenge the data model,
replay strategy, testing approach, and language choice.

## Deterministic inputs

Every envelope includes chain ID, block number/hash/timestamp, transaction index/hash, and log
index. The engine normalizes hex values and rejects conflicting or backward cursors. Inputs are:

- `MarketTermsConfigured` for the trading window, price tick, and base step;
- `MarketStateChanged` and `EmergencyPauseChanged`;
- `OrderOpened`, including the full signed order, reservation, and onchain sequence;
- `OrderFilled` and `OrderCancelled`;
- `NonceInvalidated`.

The per-market/branch onchain sequence is the only time-priority input. Client time, API arrival,
database insertion order, and local wall time never affect a match. Confirmed block timestamps
deterministically deactivate expired orders. The global expiry heap makes this `O(log N)` without
scanning every book for each event. Every book requires an exact, gap-free open sequence (including
IOC opens); a gap stops ingestion so the indexer must backfill before matching continues. Order-open
preflight also checks the onchain quantity step and price tick before journaling.

## Hot-path structures

Each book uses:

| Structure | Purpose | Cost |
| --- | --- | --- |
| `Map<orderHash, order>` | Canonical active-order lookup | Average `O(1)` |
| Sorted dense price array per side | Best-price traversal | `O(1)` best edge; `O(log L)` insertion search |
| `Map<price, level>` | Direct price-level lookup | Average `O(1)` |
| Intrusive `previous`/`next` hashes | FIFO and cancellation within a level | `O(1)` |
| Global expiry min-heap | Deterministic expiry deactivation | `O(log N)` |
| One pending proposal per book | Settlement backpressure | Bounded by 32 fills by default |

Dense price arrays were chosen because v1 market tick ranges are bounded and V8/Bun implements
dense moves efficiently. If profiles show new-level insertion dominating, the `PriceSide` boundary
can be replaced with a tree without changing proposal or checkpoint formats.

All quantities, prices, sequences, timestamps, and fencing tokens use `bigint`. Canonical JSON tags
bigints explicitly, sorts object keys, preserves array order, and hashes with Keccak-256.

## Proposal algorithm

For each step, the matcher selects the highest available bid and lowest available ask. If they
cross, the lower onchain sequence is the maker, its signed limit is the execution price, and the fill
quantity is the smaller available quantity. The proposal records both top-level FIFO queues before
every decision.

A preview does not mutate pending quantities. The service then:

1. obtains or renews the book lease and fencing token;
2. compares the optimized preview with the independent flat-array reference matcher;
3. persists the proposal and fairness decision;
4. commits its quantities as pending in both engines;
5. hands the durable proposal to the settlement-worker boundary.

Only a confirmed `OrderFilled` input reduces remaining quantity. A revert, cancellation, nonce
invalidation, expiry, pause, market freeze, or competing IOC fill releases/invalidate reservations
before rematching. This prevents the same quantity from appearing in overlapping proposals.

## Persistence and recovery

`MatcherStore` is the persistence boundary. The implementation supplies an in-memory fault-test
adapter and a PostgreSQL/Drizzle adapter with:

- append-only canonical/orphan event rows;
- Keccak-verified checkpoints;
- one active proposal per book;
- persisted simulation, transaction, receipt, and status history;
- atomic lease takeover with monotonically increasing fencing tokens;
- fairness decision records.

PostgreSQL is required in development and deployment. The coordinator serializes asynchronous mutations and recovers from a consistent journal/proposal snapshot.

On restart, the coordinator verifies the newest canonical checkpoint, replays later events, commits
active proposals at their exact creation cursor, and compares reconstructed reservations with the
durable records. On reorg, events after the common block become orphaned, affected/active proposals
become `reorged`, the engine rebuilds from the last surviving checkpoint, and the same proposal ID is
reused only if the reconstructed cursor and pre-book state are identical.

The optimized and reference engines compare each event result and every potential match. A complete
checkpoint comparison runs every 100 events by default and during recovery, bounding detection time
for any state-only divergence while avoiding a full-book hash on every no-cross event.

## Verification and operations

Run:

```bash
bun test packages/orderbook/tests services/matcher/tests
bun run --filter @conditional-stocks/orderbook benchmark
```

The benchmark includes canonical validation, normalization, hashing, and event application. During
implementation, 25,000 opens across 1,000 price levels ran at roughly 31,000 events/second on the
development machine under Bun 1.3.14. This is only a local regression reference; chain ingestion,
PostgreSQL durability, settlement, and production hardware require separate service-level tests.

The test suite covers golden maker-price/FIFO vectors, multiple levels, partial and many-to-one
fills, both branches/funding kinds, batch boundaries, cancellation/nonce/expiry/freeze/IOC races,
cutoff behavior, checkpoint corruption, duplicate/conflicting cursors, lease fencing, crash
boundaries, partial settlement recovery, PostgreSQL reconnect, reorg convergence, randomized comparison,
and injected shadow divergence.

No implementation can honestly guarantee zero defects. Before production, this component still
requires independent security review, sustained load/soak testing, testnet fault injection, and
end-to-end validation with the milestone 10 indexer and milestone 11 settlement worker.
