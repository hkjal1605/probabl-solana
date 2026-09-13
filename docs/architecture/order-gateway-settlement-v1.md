# Order gateway and settlement v1

> Historical design record, superseded for trading execution on 2026-09-08 by [permissionless atomic placement](./atomic-placement.md). The matcher and settlement-worker runtime code, trading queues and nonce allocator have been removed. Do not use the old startup commands or trading endpoints below.

## Safety boundary

The gateway accepts user intent; it is not an order ledger. The settlement worker accepts matcher
proposals; it is not a custody ledger. Only confirmed Robinhood Chain events projected by Ponder are
canonical.

```text
wallet -> gateway -> signed openOrder -> ConditionalExchange -> Ponder -> matcher
                                                               ^            |
                                                               |            v
                                                     MATCHER_ROLE tx <- settlement worker
```

- A GTC order is actionable only after Ponder projects `OrderOpened`.
- A fill is complete only after Ponder confirms the exact `OrderFilled` tuple(s).
- API operation state and canonical state are returned separately.
- The gateway never stores user private keys. Maker cancellation and position actions are signed by
  the wallet and submitted as raw transactions.
- The order-opening relayer has no protocol role. It can only submit already signed intent whose
  funding is pulled from the maker by `ConditionalExchange`.
- The settlement relayer has `MATCHER_ROLE` only. It cannot create/freeze/resolve markets, change
  terms, administer roles, cancel maker orders, redeem claims, or transfer escrow arbitrarily.

## Gateway flow

1. The wallet obtains a five-minute, single-use sign-in challenge and exchanges its signature for a
   24-hour opaque bearer session. Only a hash of the bearer token is stored. Viem verification
   supports EOAs and contract wallets.
2. `POST /v1/orders/prepare` parses integer amounts only from decimal strings and returns the exact
   v1 EIP-712 data, order hash, safe block, worst-case reservation, approval transaction if needed,
   and conditional-claim payoff preview.
3. Preparation reads one Ponder confirmed head and performs batched RPC reads at that block for
   market terms, pause state, nonce floor, and caps. Funding balance/approval reads use the same
   block.
4. `POST /v1/orders/submit` requires an idempotency key, persists the accepted request, verifies the
   EOA/ERC-1271 typed-data signature, repeats all domain/market/funding checks, and simulates at both
   the Ponder safe block and the latest RPC state.
5. For relayed GTC orders, a dedicated roleless key signs a transaction with a PostgreSQL-allocated
   nonce. The serialized transaction is persisted before broadcast. A retry rebroadcasts the same
   bytes and cannot create duplicate escrow.
6. If the relayer/paymaster is unavailable, the wallet may supply an exact user-signed `openOrder`
   transaction. The gateway recovers its signer and rejects any mismatch in chain, destination,
   value, or calldata.

Cancellation, merge, and redemption always use the same exact raw-transaction verification. This is
required because `cancelOrder` deliberately authorizes `msg.sender == maker`; the backend does not
have cancellation authority.

## Protected IOC flow

The IOC signature commits to quantity and limit price. The API additionally requires exact
`maxQuantity`, `worstPriceRawX18`, and a `maxNotional` that covers the signed worst-case reservation.
The intent is persisted by the worker in `waiting-match` state. Matching remains outside the API.
The matcher submits an ordered plan of at most 32 live maker orders. The worker verifies that every
maker is on the same market/branch, opposite side, within the taker's worst price, and within the
maximum quantity before building one atomic `IOCRouter.executeIOC` call. Any unfilled taker remainder
is canceled inside that same transaction.

## Settlement state machine

```text
queued -> simulated -> submitted -> mined -> confirmed
   |          |             |
   |          |             +-> replacement attempt (same nonce, bumped fees)
   |          +-> quarantined (simulation/canonical disagreement)
   +-> quarantined (unsafe cursor, changed order, pause/freeze)
submitted -> failed (canonical transaction revert)
```

The worker validates the matcher schema/engine and recomputes the proposal hash before persistence.
It then makes one Ponder settlement-context request for the proposal cursor, all required orders,
market states, and protocol pause state. Required quantities are accumulated per order, preventing a
multi-leg proposal from passing validation by checking each leg in isolation.

Each GTC fill is an exact `ConditionalExchange.matchOrders` transaction. A proposal may therefore
have several sequential, explicitly nonced transactions. Each serialized attempt is committed with
`synchronous=FULL` before any broadcast. Replacement attempts use the same nonce and a configured
fee bump. IOC plans produce one `executeIOC` transaction.

Receipts move a batch to `mined`; they do not confirm it. Ponder must return the exact expected fill
multiset for the mined transaction hashes at its confirmed head before the worker marks the batch
`confirmed`. Failure/quarantine notifications are themselves a durable outbox and retry until the
matcher releases pending quantities. Matcher success still comes only from canonical fill events,
never from the callback.

## Persistence and availability

Both services use one PostgreSQL database with Drizzle schemas, bounded pools and synchronous commits. See the [shared PostgreSQL runbook](../runbooks/shared-postgres.md). A process crash can leave an attempt in `prepared` state;
the next owner rebroadcasts its stored bytes. A network/indexer outage leaves the batch in its last
durable nonterminal state. A different worker may claim it after the lease expires.

Database-backed uniqueness, server-clock leases and fencing protect shared operational state. Infrastructure failover/load verification remains required before enabling multi-host operation.

## Deliberate v1 exclusions

There is no KYC or eligibility gating, custodial user key, automated market creation, automatic
Polymarket resolution, cross-chain message, or matching logic in the API. Market creation and
resolution remain explicit manual admin transactions.
