# V1 Polymarket data and admin evidence API

## Authentication and deployment

Public market-data routes require no wallet session. `/v1/admin/*` routes require a bearer session
from `/v1/auth/challenge` and `/v1/auth/verify`, and the authenticated wallet must equal
`MARKET_ADMIN`. That wallet can prepare, approve and execute creation and resolution. Legacy
`ADMIN_OPERATOR_ADDRESSES` and separate Safe-address settings do not authorize API access.
The API does not sign or broadcast transactions. Onchain roles remain enforced; the same wallet
needs both `MARKET_ADMIN_ROLE` and `RESOLUTION_ADMIN_ROLE`. See [single-admin setup](../runbooks/single-market-admin.md).

The ingestor `/internal/*` routes require `Authorization: Bearer <POLYMARKET_INTERNAL_TOKEN>` and
must also be network-private. Its `/v1/polymarket/*` routes expose normalized display data.

## Public routes

- `GET /v1/markets/:marketId/polymarket` returns the immutable local market association, latest
  normalized metadata and probability, `informationalOnly: true`, and
  `settlementAuthority: "manual-admin-only"`.
- `GET /v1/markets/:marketId/probability` is the lower-overhead probability-only market route and
  returns the same trust-boundary labels.
- `GET /v1/markets/:marketId/resolution-evidence` returns the approved packet, its explicit
  review, generated previews, canonical observations, and status.
- `GET /v1/polymarket/conditions/:conditionId/metadata` on the ingestor returns its latest immutable
  raw/normalized metadata snapshot.
- `GET /v1/polymarket/conditions/:conditionId/probability` returns the latest YES-book tick.
- `GET /v1/polymarket/conditions/:conditionId/stream` is a WebSocket that immediately sends the
  current tick and then `{ "topic": "probability.<conditionId>", "value": ProbabilityTick }`.

Price, size, time, depth, index, and payout numbers are decimal strings. `midpointX6` is null unless
`quality` is `valid`; clients must not calculate or substitute a value for any other quality state.

## Creation workflow

1. `POST /v1/admin/polymarket/metadata/fetch`

   ```json
   { "gammaMarketId": "12345" }
   ```

2. `POST /v1/admin/evidence/creation/prepare` with the returned `snapshotId`:

   ```json
   {
     "metadataSnapshotId": "0x...",
     "sourceUrls": ["https://gamma-api.polymarket.com/markets/12345"],
     "attachments": [{
       "filename": "gamma-market.json",
       "mediaType": "application/json",
       "contentBase64": "ey4uLn0="
     }],
     "config": {
       "baseToken": "0x...",
       "quoteToken": "0x...",
       "tradingOpen": "1788566400",
       "tradingCutoff": "1788652800",
       "priceTickRawX18": "10000",
       "baseStep": "1000000000000000000",
       "minNotional": "1000000",
       "maxOrderQuantity": "100000000000000000000",
       "maxOrderNotional": "1000000000",
       "maxWalletOpenNotional": "10000000000",
       "maxMarketOpenNotional": "1000000000000",
       "rules": "Exact local rules snapshot",
       "metadataUri": "ipfs://published-market-metadata"
     }
   }
   ```

3. MARKET_ADMIN calls `POST /v1/admin/evidence/:packetHash/review`:

   ```json
   {
     "decision": "approve",
     "notes": "source and immutable terms verified",
     "checklist": {
       "stock-and-quote": true,
       "condition-id": true,
       "yes-no-orientation": true,
       "rules-and-dates": true,
       "source-and-raw-hash": true
     }
   }
   ```

4. `POST /v1/admin/evidence/:packetHash/transaction` returns a simulated `create-market`
   transaction (a real RPC dry-run, not simulated application data). The admin UI locally rebuilds
   and verifies the calldata, then MARKET_ADMIN signs it in its wallet. Safe export is also available.
5. Before signing, call `POST /v1/admin/evidence/:packetHash/verify-transaction` with the proposed
   transaction. Any field mismatch returns `409 TRANSACTION_MISMATCH`.
6. After Ponder indexes execution, call `POST /v1/admin/evidence/:packetHash/reconcile` with
   `{ "action": "create-market", "transactionHash": "0x..." }`. This verifies every onchain term
   and starts display-data tracking.

## Resolution workflow

The market must already be `Frozen` or `AwaitingResolution`.

1. `POST /v1/admin/evidence/resolution/prepare`:

   ```json
   {
     "marketId": "0x...",
     "metadataSnapshotId": "0x...",
     "officialStatus": "resolved-final-after-dispute-window",
     "officialUrl": "https://polymarket.com/event/example",
     "payout": { "yes": "1", "no": "0", "denominator": "1" },
     "polygon": {
       "chainId": "137",
       "conditionalTokensAddress": "0x...",
       "transactionHash": "0x...",
       "blockHash": "0x...",
       "blockNumber": "70000000"
     },
     "sourceObservations": [{
       "observedAt": "2026-09-05T12:00:00.000Z",
       "status": "final",
       "url": "https://polymarket.com/event/example",
       "payout": { "yes": "1", "no": "0", "denominator": "1" }
     }],
     "sourceReference": "ipfs://published-resolution-packet",
     "attachments": [{
       "filename": "polygon-export.json",
       "mediaType": "application/json",
       "contentBase64": "ey4uLn0="
     }]
   }
   ```

   `transactionHash`, `blockHash`, and `blockNumber` may be null when unavailable, but the Polygon
   chain ID, CTF address, official observation, and durable source reference are mandatory.

2. The same MARKET_ADMIN approves with the checklist keys `frozen-or-awaiting`, `condition-id`,
   `yes-no-orientation`, `final-status`, `polygon-reference`, `attachments`, and `payout-vector`.
3. While the market is frozen, the transaction route returns `begin-resolution`, whose reason hash
   commits to chain, controller, market, payout, packet hash and URI. Verify it, execute it
   with MARKET_ADMIN, and reconcile it.
4. Once Ponder shows `AwaitingResolution`, the same transaction route returns `resolve-market`.
   Verify it, execute it with the same MARKET_ADMIN wallet (which must also hold the
   resolution role), and reconcile it.

`GET /v1/admin/evidence/:packetHash` can be used at every step to inspect the immutable packet,
review, previews, observations, and derived status.

## Ingestor administrative routes

- `POST /internal/metadata/fetch` — fetch and append one Gamma market snapshot.
- `POST /internal/subscriptions` — bind one already-reviewed snapshot and bootstrap its YES book.
- `POST /internal/reconcile/:conditionId` — replace the local book with a fresh REST snapshot.
- `POST /internal/events` — test/controlled event injection; never expose publicly.
- `GET /internal/metadata/snapshots/:snapshotId` and `GET /internal/alerts` — audit/operations.

Expected conflict codes include `MAPPING_MISMATCH`, `CONFLICTING_EVIDENCE`, `WRONG_NETWORK`,
`ADMIN_FORBIDDEN`, `INCOMPLETE_REVIEW`, `TRANSACTION_MISMATCH`, `CANONICAL_MISMATCH`, and
`TAMPERED_ATTACHMENT`. Dependency failures use `SOURCE_UNAVAILABLE` or a canonical-state error and
must not be bypassed by an operator.
