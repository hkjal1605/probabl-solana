# Market read reliability

UI reads are not transaction authority. Polling failures must not erase known
rows, manufacture zero balances, or claim that a market closed. Failed initial
loads still show an actionable error. Background failures retain previous rows
with a quiet, space-reserved reconnecting status. Partial books retain display
rows but are explicitly unavailable for market-order bounds. Data older than
30 seconds (15 seconds for readiness), a failed read or clock rollback disables
balance/position shortcuts. A source `observedAt` timestamp is respected where
provided. No stale price or balance becomes usable by relabeling it as fresh.

Normal market/order/position/balance/trade/readiness polls are 10 seconds, shared
by deployment and wallet identity. Transient GET errors receive two bounded
retries, respecting a bounded Retry-After; a failed query polls every 30 seconds.
Background-tab polling is disabled. Mutations and signing are never retried.
Order review, funding and submission explicitly recheck availability, in addition
to the existing API, SDK and on-chain validations. Failures do not clear a user's
form or reviewed instruction bundle. Cutoff checks continue with wall-clock time.

The advisory readiness route returns HTTP 200 with `healthy: false` and a reason
for an actual closed, scheduled or paused market. RPC failures return HTTP 503
with `reason: unavailable`, never `closed`. Its shared read cache lasts 2 seconds.
Informational reference-market account reads cache for 3 seconds. These caches
are not used by governance authorization or transaction endpoints.

Indexer positions batch five accounts per initialized market, at most 100 per
RPC, using finalized reads with the snapshot slot as a lower bound. Per-wallet
position/balance reads share a 3-second bounded cache. Expired successes are never
served after a loader failure; repeated failures briefly share backoff. Identity,
owner/program and incomplete-response failures remain fail-closed. Indexer
refresh retries back off to at most 15 seconds; the existing strict 15-second
snapshot/history/reconciliation readiness checks are unchanged.

## RPC configuration

The browser's `DEVNET_BROWSER_RPC_URL` does not update existing EC2 processes.
Both `.local/ec2/env/api.env` and `.local/ec2/env/indexer.env` need a suitable
devnet `SOLANA_RPC_URL`. Verify its full genesis hash before switching. Preserve
all database/auth/provider settings, keep env files mode 0600 and directory 0700,
and restart only the affected services. Never log credentials or copy the root
`.env.devnet` to EC2. The mainnet `JUPITER_PRICE_RPC_URL` is unrelated and must not
be changed to devnet. Configure the deployment-side `DEVNET_RPC_URL` appropriately
for future backend environment exports too.

`ops/ec2/solana/update-rpc.ts --execute` runs only in the dedicated EC2 checkout.
Supply only the new RPC URL through private stdin, not CLI arguments or shell
history. It verifies genesis, preserves unrelated settings, makes private
server-side backups and atomically replaces each env file. Never download whole
runtime env files just to change one setting. The script does not restart services.

Production needs a dedicated RPC sized for active users and indexing load;
client caching is not a substitute for reliable infrastructure. After deployment,
check readiness, reconciliation, positions/balances and rate-limit log growth.
No new contracts, database migration, automatic order or on-chain write is needed.
