# Indexed reads and market streams

## Data paths

- Order review uses the committed `solana_snapshots` database image. It does not call `getProgramAccounts` or prepare custody instructions on the API server. Missing, failed, or older-than-15-second snapshots fail closed; there is no hidden RPC fallback.
- Funding is built locally from two account batches: market + unique participant credit accounts, then mint + both possible token-program ATAs. Token-2022 transfer-fee mints additionally require a current epoch read. Account ownership, mint extensions, token identity, net credit bounds, and signed-message equality are still checked.
- API planning and browser funding validation run concurrently. Funding refreshes the execution review automatically after confirmation. This does not auto-place an order or reuse the pre-funding quote.
- The selected market screen no longer reloads every market and every orderbook.
- `/stream` on the indexer publishes committed index changes, readiness, and the subscribed wallet's persisted image. One browser connection is shared by all market queries. Metadata/orderbook/trade requests run initially and on relevant changes, not on every heartbeat.
- `/v1/spot-prices/stream` streams reference prices separately. Identical browser subscriptions share a connection, and the existing Jupiter provider coalesces overlapping requests. The existing Polymarket probability WebSocket remains in place.
- Active wallet positions and token balances share one background index image rather than separate per-component RPC requests. Mint reads are shared across wallets. Images are persisted in `solana_wallet_snapshots` before serving. Active wallet registration is bounded to 128 wallets per process and expires after 60 seconds without a read/stream heartbeat.

## Remaining deliberate work

Zero RPC is neither possible nor a safety target: the indexer must observe chain state, external wallet transfers are outside program accounts, and signing needs fresh funding accounts, a blockhash, preflight and confirmation.

The indexer still performs one shared full program snapshot every five seconds. History/reconciliation run on changed program state and at least every 30 seconds. Active wallet accounts refresh every ten seconds in batches of at most 100; mint metadata reads are shared for ten seconds. This is bounded background polling, not per-browser polling. A future subscription-driven indexer can reduce this further but must retain gap recovery and reconciliation.

SSE is an advisory display transport, never an authorization or execution oracle. Browser HTTP fallback remains enabled on stream failure or query errors. Unknown stream gaps/restarts trigger resynchronization. Slow-client pending updates are coalesced. Closed/cutoff status is recomputed as time advances even when account bytes do not change. Wallet/spot data retains its own timestamp and expires independently of stream heartbeats.

Native SSE does not carry trading bearer tokens in URLs. Streamed wallet data is public chain-derived information, as with existing unauthenticated balance endpoints. Wallet changes close the old subscription.

## Deployment order

1. Deploy/restart the indexer first. Its existing snapshot JSON gains raw account images and an explicit health flag; the wallet-image table is created at startup. Wait for a healthy snapshot and reconciliation.
2. On EC2 run `bun ops/ec2/solana/grant-indexed-reads.ts` using the existing private indexer environment. This grants only schema usage and snapshot-table SELECT to the API role. Restart the API through the ecosystem file, which sets `INDEXER_SNAPSHOT_SCHEMA=solana_indexer`. Readiness and review now require the new database snapshot format. Old indexer data deliberately produces an unavailable error, not an RPC scan.
3. Apply the updated nginx configuration, validate with `nginx -t`, then reload. Both SSE locations disable buffering and allow long reads. Bun servers use a 60-second idle timeout; heartbeats arrive sooner.
4. Deploy/restart the UI. `/api/stream` forwards the streaming body without buffering or a short request timeout. Confirm reset/index events, wallet changes, spot events, and reconnect recovery in the browser.

No deployment, key changes, live orders, or production schema changes are performed by the local implementation tests. Existing sessions and the separate market-maker work are unrelated to this rollout.

## Verification

Tests cover two-batch SPL/Token-2022 funding, account substitution rejection, shared wallet-image persistence, stream parsing, stale/forged payload rejection, no-change topic detection, HTTP fallback, and stream cancellation. Validator-dependent and deployment smoke tests must also be run before claiming production latency or end-to-end chain validation. No latency percentage is inferred from request counts alone.
