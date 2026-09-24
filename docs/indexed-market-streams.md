# Indexed reads and market streams

## Live chain index (Yellowstone gRPC)

The indexer and the API each run the same live index
(`services/solana-indexer/src/live`). It is built on Yellowstone gRPC, the
Geyser streaming interface served by Alchemy, Triton, Helius LaserStream,
QuickNode and the `yellowstone-grpc-geyser` validator plugin. Only the indexer
subscribes upstream; the API reads the indexer's loopback relay (below).

- **Bootstrap:** one finalized `getProgramAccounts` (plus the listed issuer
  mints and pool vaults) at slot `F`. The stream then subscribes with
  `from_slot = F + 1`, so no update between the RPC read and the stream is missed.
- **One subscription:** every program account (owner filter), the tracked
  issuer mints and pool vaults, successful program transactions, block times
  and every slot status. Newly listed legs are added to the same subscription
  and seeded from RPC.
- **Two views, both immutable snapshots, replaced per slot:**
  - **confirmed:** updates for a slot are staged and applied together when
    the cluster confirms that slot, the same moment RPC `confirmed`
    confirmation returns. There is no polling interval. Trading reads (markets, order books,
    orders, SSE, order planning in the API) use this view.
  - **finalized:** a confirmed slot is folded in when a descendant is
    finalized and the slot is on the finalized chain. Custody reads
    (balances, positions, payouts, resolutions, reconciliation) and durable
    persistence use this view.
- **Forks:** slots of abandoned forks (known from the parent carried by each
  slot's processed status) are dropped when a descendant finalizes, and the
  confirmed view is rebuilt from the finalized base. Their transactions are
  never persisted. (The subscription omits inter-slot statuses, which also
  omits `dead`; forks are pruned at finalization instead.)
- **Incremental:** each committed slot re-decodes only the accounts it changed,
  copying only the maps of the kinds that changed. Live issuer leg state is
  recomputed only when a tracked mint/vault or a market changes (and every 2 s
  for time-based multiplier schedules).
- **Reconnects:** a reconnect resumes after the last confirmed slot (everything
  up to it is already committed or pending finalization here). Replayed
  updates are idempotent, ordered by `(slot, write_version)`, and duplicate
  transactions are dropped. If the server can no longer replay that far, the
  index re-bootstraps from RPC and finalized history is backfilled from RPC.
  The same happens if a streamed account fails authentication (a
  non-canonical PDA).
- **Health:** reads fail closed (503) while the stream is disconnected, silent
  for more than 15 s, or re-bootstrapping.

The indexer persists the finalized view and its program-event history to
PostgreSQL. This runs in one ordered, coalescing worker, so the stream never
waits on the database. History comes from the streamed transactions of each
finalized slot. After a gap or a persistence failure it is replayed from RPC
instead. Order history (`OrderRetired`) and trades are published at confirmed
(`confirmation: "confirmed"`) and persisted when final.

Configuration: `YELLOWSTONE_GRPC_URL` (required) and `YELLOWSTONE_X_TOKEN`
for hosted endpoints. For local validators, `bun scripts/solana/yellowstone.ts`
installs the plugin and writes its `--geyser-plugin-config`.

### Streamed bytes (hosted gRPC is billed per byte)

What the single subscription carries, and why each part is needed:

| Stream | Needed for | Share of bytes under trading load |
|---|---|---|
| Program accounts (owner filter) | every order book, market, wallet and custody read | ~45% |
| Program transactions (no votes, no failures) | trades, market creation, leg and resolution events, retired orders (finalized history) | ~45% |
| Block metadata | exact block times of events | ~7% (≈200 B per block) |
| Slot statuses (processed, confirmed, finalized) | commits, finalization, fork parentage | ~3% (≈28 B each) |
| Listed issuer mints and pool vaults | live leg state (pause, freeze, multiplier) | ~1% |

Measured with the market-maker flow on a local validator:

- **zstd compression** is requested by default and cuts wire bytes by about
  40% (large account images and logs compress well). If an endpoint rejects
  compressed requests the stream reconnects uncompressed automatically;
  `YELLOWSTONE_COMPRESSION=none` disables it. Alchemy's streaming endpoint
  (checked 2026-09-25) rejects both gzip and zstd requests, so the devnet
  indexer sets `none` and its stream is billed uncompressed.
- **One upstream subscription per host.** The indexer relays the account and
  slot events it receives on loopback (`INDEXER_RELAY_PORT`, default 42070,
  bound to 127.0.0.1). The API reads them there (`INDEXER_RELAY_URL`), with
  the same resume-from-slot semantics, so it neither streams nor holds the
  gRPC token. Transactions and block times are not relayed.
- **Compact market account.** Every placement rewrites the market, so its
  image is kept small: the resolution evidence URI is allocated only when the
  market resolves, and the race-check ring stores 9 bytes per placement
  (a market is ~1.7 KB instead of ~2.7 KB).
- **Keep-alive:** the server pings every ~10 s and the client only answers.
- **Not streamed:** votes, failed transactions, blocks, entries, inter-slot
  statuses, other programs' accounts. Transactions arrive with Solana's
  standard metadata (token balances, inner instructions), which Yellowstone
  cannot trim. Transaction and account filters cannot usefully narrow further:
  every deployment instruction touches this program, and cancellations or pool
  transfers need not reference the config.

RPC is kept off hot paths too: the lookup-table keeper reads its tables only
when some desired address is missing (or every 60 s), and the SDK reuses
keeper table contents for 2 s across placements (tables are append-only, so a
cached copy can only miss the newest entries).

## Other data paths

- Funding is built locally from two account batches: market + unique participant credit accounts, then mint + both possible token-program ATAs. Token-2022 transfer-fee mints additionally require a current epoch read. Account ownership, mint extensions, token identity, net credit bounds, and signed-message equality are still checked.
- API planning and browser funding validation run concurrently. Funding refreshes the execution review automatically after confirmation. This does not auto-place an order or reuse the pre-funding quote.
- `/stream` on the indexer pushes each confirmed commit's invalidations immediately (event-driven, 15 s heartbeat), plus readiness and the subscribed wallet's persisted image. One browser connection is shared by all market queries.
- `/v1/spot-prices/stream` streams reference prices separately. Identical browser subscriptions share a connection, and the existing Jupiter provider coalesces overlapping requests.
- Active wallet positions and token balances share one background index image. Images are persisted in `solana_wallet_snapshots` before serving. Active wallet registration is bounded to 128 wallets per process and expires after 60 seconds without a read/stream heartbeat.

SSE is an advisory display transport, never an authorization or execution oracle. Browser HTTP fallback remains enabled on stream failure or query errors. Unknown stream gaps/restarts trigger resynchronization. Slow-client pending updates are coalesced. Closed/cutoff status is recomputed as time advances even when account bytes do not change. Wallet/spot data retains its own timestamp and expires independently of stream heartbeats.

Native SSE does not carry trading bearer tokens in URLs. Streamed wallet data is public chain-derived information, as with existing unauthenticated balance endpoints. Wallet changes close the old subscription.

## Deployment order

1. Provide a Yellowstone gRPC endpoint for the cluster (`DEVNET_YELLOWSTONE_GRPC_URL` and token in `.env.devnet`; `ops/ec2/solana/stage-env.ts` stages it for the API and the indexer).
2. Deploy/restart the indexer first and wait for `/health` to report a confirmed and a finalized block, and for `/reconciliation`.
3. Restart the API. It bootstraps its own live index and is ready once the stream is healthy.
4. Apply the nginx configuration (SSE locations disable buffering and allow long reads), then deploy the UI with each origin in `API_AUTH_ORIGINS`.

## Client organization

`services/*-api-service.ts` owns HTTP requests, module `utils/fetch*.ts` coordinates loading, and `stores/use*Store.ts` owns domain state using vanilla Zustand plus bounded React hooks. Components retain the existing Probabl screens. The shared transport validates the API origin and attaches a trading bearer token only to explicit authenticated calls; no server credentials enter the UI.

Resource reads are single-flight per domain/key. SSE updates the same stores, and an older HTTP response cannot overwrite a newer streamed wallet/readiness image. Wallet changes clear private session-related caches and abort their pending reads. HTTP refreshes are a recovery path when streams are unavailable, not a parallel fixed polling loop. Positions and balances use one wallet image. Spot subscriptions have a short initial SSE grace period before HTTP fallback. Mutations are never automatically retried by the transport.

No deployment, key changes, live orders, or production schema changes are performed by the local implementation tests. Existing sessions and the separate market-maker work are unrelated to this rollout.

## Verification

Tests cover the live index (commitment staging, fork pruning, dead slots, reconnect replay and gap resync, incremental decoding, leg tracking), the finalized persistence worker, two-batch SPL/Token-2022 funding, account substitution rejection, shared wallet-image persistence, stream parsing, stale/forged payload rejection, no-change topic detection, HTTP fallback, and stream cancellation. The application validator test asserts a confirmed fill is visible through the indexer within one second of RPC confirmation, and that the streamed index equals a direct RPC read of the same confirmed slot. No latency percentage is inferred from request counts alone.
