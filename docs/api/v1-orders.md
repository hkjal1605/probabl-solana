# Order and position API — v2 raw-unit payloads

The `/v1` route prefix and v2 raw-unit market identities are retained. Order signing is now EIP-712
version **3**, with a signed `maxFeeBps`; pre-fee signatures are incompatible.
See [trading fees](../architecture/trading-fees.md) and [raw-unit pricing](../architecture/raw-unit-ratio-v2.md).
Amount fields are raw token units; price fields are raw quote/raw base ratios scaled by `1e18`.
Prepare responses include verified token units and per-asset decimals for display.

Raw amount and price integers in request JSON are decimal strings. Enums and `maxFeeBps` are JSON
integers; the fee cap must be 0–1000. Responses also render bigint values as
decimal strings. Only cancellation/position submission endpoints require an `Idempotency-Key` header containing
8–128 safe ASCII characters.

## Authentication

- `POST /v1/auth/challenge` — `{ "address": "0x…" }`
- `POST /v1/auth/verify` — `{ "address", "challengeId", "signature" }`

Authenticated endpoints require `Authorization: Bearer <session>`. The authenticated address must
equal the order maker or transaction signer.

## Order schema

```json
{
  "maker": "0x...",
  "recipient": "0x...",
  "marketId": "0x...32-bytes",
  "branch": 0,
  "side": 0,
  "fundingKind": 0,
  "quantity": "1000000000000000000",
  "limitPriceRawX18": "200000000",
  "tif": 0,
  "expiry": "1800000000",
  "nonce": "0",
  "salt": "0x...32-bytes",
  "maxFeeBps": 0
}
```

Enums are `branch: YES=0, NO=1`, `side: BUY=0, SELL=1`, `fundingKind:
WHOLE_COLLATERAL=0, ACTIVE_CLAIM=1`, and `tif: GTC=0, IOC=1`.

The example buys one stock18 token at 200 USDG6. Its reservation is `200000000` raw USDG.
Its zero fee cap prohibits fee-bearing fills. An omitted cap defaults to zero only. An explicit
cap of 25 authorizes up to 0.25% of received active claims, not extra input collateral. Preparation
includes `fees.maxFeeBps`, the fee asset/basis, and a notice that payoff amounts are before fees.
An admin rate increase above the signed cap cannot fill the order; cancellation remains free.

## Endpoints

- `POST /v1/orders/prepare` — body `{ "order": Order }`; returns exact EIP-712 typed data, hash,
  safe-block context, reservation, approval call, payoff preview, `atomicRouter`, `executionVersion: 1`, current fee rates and `plan`.
- `POST /v1/orders/transaction` — body `{ "order": Order, "signature": "0x…", "plan": Plan }`;
  verifies the owner, safety, funding, fee caps and exact latest-chain simulation, then returns HTTP 200
  `{ orderHash, executionVersion: 1, transaction: { chainId, from, to, value: "0", data } }`.
  This is read-only: no server signing, transaction broadcast, durable intent or order queue.
- `POST /v1/orders/submit` was removed and returns 404. There is no legacy fallback.
- `POST /v1/orders/cancel/prepare` — body `{ "orderHash": "0x…" }`; returns maker-only calldata.
- `POST /v1/orders/cancel/submit` — adds `signedTransaction` and broadcasts only after recovering
  and validating its signer, chain, target, value, and exact calldata.
- `GET /v1/orders/:orderHash` — returns `{ application, canonical }`; canonical data comes from
  Ponder.
- Canonical indexed orders include `filled` (executed raw base units). Cancellation
  clears live `remaining` and `reserved` to zero but preserves `filled`; never infer
  historical execution as `quantity - remaining` for a cancelled order.
- `GET /v1/operations/:operationId` — returns attempts, replacement links, persisted receipt, and
  current application state.
- `POST /v1/positions/merge/{prepare,submit}` — accepts `marketId`, `collateral` (`base` or `quote`),
  `amount`, and `recipient`; submit also accepts the exact wallet-signed transaction.
- `POST /v1/positions/redeem/{prepare,submit}` — accepts `marketId`, `collateral`, one or two unique
  index sets (`"1"` YES, `"2"` NO), matching amounts, and recipient. The preview uses the canonical
  manual resolution vector.

## Atomic plan and wallet execution

`Plan` contains `makers: Order[]`, `quantities: string[]`, `expectedRemaining: string[]`,
and `deadline: string`. Arrays must have equal lengths and at most 32 distinct makers.
The API also returns derived `filledQuantity`, `remainingQuantity` and `executionQuote`;
the UI recomputes these from the execution fields. Prices and quantities stay in raw units.
Execution quote is gross, before received-claim fees.

The API selects eligible opposite-side GTC makers, best price first and FIFO within a price.
Its canonical query filters expiry, nonce invalidation, fee caps, side/branch, crossing price
and anchor eligibility **before** the 33-row window. A sweep requiring maker 33 is rejected.
An empty plan is valid: GTC rests fully funded, IOC cancels/refunds in the same transaction.

The UI builds EIP-712 data from its configured chain/exchange and the user's retained order.
After signing, it reconstructs the router calldata locally, compares every transaction field
returned by the API, and asks the wallet to broadcast that exact transaction. The wallet
must be the order owner. Required ERC-20/ERC-1155 approvals are separate transactions.
Quotes normally expire after 60 seconds (or the order expiry, if sooner).

The transaction opens escrow and settles all quoted legs or reverts entirely. It never
silently falls back to resting after an execution failure. Changed maker remainders, expiry,
cancellation, reorgs or insufficient fee caps require a fresh reviewed quote. Gas is payable
even on revert. Use the transaction receipt and canonical indexed state, not a successful
HTTP quote, as execution evidence. New atomic orders have no gateway operation record;
`GET /v1/orders/:orderHash` may therefore return `application: null`.

The contract verifies validity, not global best-price, FIFO or plan completeness.
Concurrent placements may leave crossed resting orders; no background process clears them.
See [the execution specification](../architecture/atomic-placement.md).

## Cancellation/position application states

- `accepted`: request and digest persisted.
- `prepared`: serialized signed transaction persisted before broadcast.
- `broadcast`: RPC accepted the exact transaction hash.
- `retryable`: a transient indexer/RPC failure occurred; retry the same idempotency key.
- `canonical`: Ponder indexed the transaction/order state; `finalReceipt` is persisted.
- `failed`: non-retryable validation, simulation, or canonical transaction failure.

An API `202` is never evidence of escrow or execution. Clients must use canonical state.

## Error taxonomy

Errors have `{ error: { code, message, details, retryable } }`.

| Code | Meaning |
| --- | --- |
| `invalid-request` | Malformed field, unsafe number, raw transaction, or idempotency key |
| `not-authenticated` | Missing/expired session or wrong wallet |
| `signature-invalid` | Challenge or EIP-712 signature failed EOA/ERC-1271 verification |
| `chain-mismatch` | Configured RPC is on another chain |
| `order-invalid`, `order-expired`, `market-not-open` | Protocol constraints reject the order |
| `balance-insufficient`, `approval-missing`, `funding-invalid` | Exact reservation cannot be pulled |
| `wallet-cap-exceeded`, `market-cap-exceeded` | Onchain open-notional cap would be exceeded |
| `simulation-failed` | Safe/latest contract simulation rejected the exact call |
| `transaction-reverted` | RPC observed a mined revert; no protocol action was applied |
| `canonical-state-unavailable`, `rpc-unavailable` | Retryable dependency outage |
| `idempotency-conflict` | The key is already bound to a different request digest |
| `not-found` | Canonical order, market, resolution, or operation is absent |
