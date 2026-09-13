# September 10 mainnet cutover

## Outcome

Contract deployment, database reset and EC2 rollout are complete. **Live indexer catch-up
and trading readiness remain blocked by RPC capacity.** This is internal-mainnet testing,
not a public-production approval or independent audit.

- Chain: Robinhood mainnet, 4663.
- Manifest: `packages/contracts/deployments/4663/v2-0x506c964f7c61c824884fc035ae33d4f6b1440887.json`.
- Earliest new contract block / indexer start: **59495524** (not the last configuration block).
- Exchange: `0xAd5193e9547b9687E88208854A2EE27864438482`.
- Projection schema: `probabl_indexer_20260910`.
- Persisted cache schema: `cs_sync_probabl_indexer_20260910`.
- API + embedded orderbook, indexer, reconciler and Polymarket ingestor run on EC2 under PM2.
- Both local UI dev servers were restarted with the new public contract addresses and
  their existing `https://api.probabl.trade` upstream overrides. No Cloudflare redeploy occurred.
- No new markets, user trades, resolutions or tester allowlists were created.

## Contracts and authority

All 12 installed runtimes were checked against the generated manifest; all 16 transactions
succeeded. Actual fees: **0.00292266715415 ETH**, gas used **22742033**. Deployer remaining
balance at verification: **0.00260129197148 ETH**. Maker and taker fees are both **0 bps**.

MARKET_ADMIN `0x727AD358b6093fF5cBECE5dE7c8aD159aEAbaba0` holds both market and resolution
roles. Guardian and governance remain distinct. Final admin
`0x4D00cfD3495c1E0e7280E74Ba92af3163Ad0531f` must accept the delayed handover on the new
authority `0x506C964F7c61C824884fc035ae33D4F6b1440887` after **2026-09-12 15:06:22 UTC**
(20:36:22 IST). This gate has not been bypassed or marked complete.

Alchemy rejected the original role-verification log range after 15 transactions had mined.
Verification now pages logs according to `INDEXER_GET_LOGS_BLOCK_RANGE`. Recovery checked
each recorded transaction's sender, chain, nonce, exact destination/calldata and successful
receipt, then verified historical constructor runtimes. Only the remaining handover
transaction was broadcast; the graph was not deployed twice. Public journals for nonces
16 and 31 are retained beside the manifest. They never contain signed payloads or private keys.

## Backup and reset

Root-only EC2 backups: `/var/backups/probabl/redeploy-20260910/`.

- `checkout-before.tar.gz`: previous source/configuration, including the old environments.
- `database.dump`: custom-format PostgreSQL backup, verified with `pg_restore --list`.
- `database-backup.json`: exact old deployment, schema inventory, size and SHA-256.
- Database dump: 3645327 bytes; SHA-256
  `2a4442284f9acfc5dbed37b705547a0002dec22bfafee57c308c42e4a589eb7c`.

All four services were stopped and their database sessions checked before backup/reset.
Only these six old schemas were removed: `gateway`, `operations`, `probabl`,
`probabl_migrations`, `probabl_indexer_atomic_v2`, `cs_sync_probabl_indexer_atomic_v2`.
Their data is recoverable from the backup. The Aurora database, public/system schemas,
service logins/passwords and privilege-group memberships were preserved. Drizzle migrations
and grants were reapplied; the deployment identity now names the new exchange.
All four runtime logins passed least-privilege verification. Do not blindly rerun the reset:
its old-exchange and exact-schema guards deliberately reject the new deployment.

Local and server environments share deployment/RPC/role/safety configuration. Database
credentials, absolute paths and frontend-only settings intentionally differ. Wallet private
keys remain local. The authenticated Alchemy URL is not copied to `NEXT_PUBLIC_*` settings.
`ops/ec2/verify-deployment-env.ts` permits challenge-bound comparison without exporting secrets.

## RPC findings and monitoring

The endpoint hostname is `robinhood-mainnet.g.alchemy.com`. Its response explicitly reports
Free-tier `eth_getLogs` ranges of at most 10 blocks. Configuration therefore uses:

```dotenv
INDEXER_GET_LOGS_BLOCK_RANGE=10
INDEXER_RPC_MAX_RPS=26
INDEXER_POLLING_INTERVAL_MS=1000
INDEXER_FINALITY_MODE=rpc-tags
INDEXER_CONFIRMATION_MODE=safe
```

The optional 26-RPS ceiling spaces request admission and preserves concurrent responses,
failover and Ponder-owned retry/backoff. It is a maximum, not an observed sustained rate,
and does not override Alchemy's weighted/account-wide limit. Alchemy's
[throughput documentation](https://www.alchemy.com/docs/reference/throughput) explains the
account-wide CU/s rolling window; [method costs](https://www.alchemy.com/docs/reference/compute-unit-costs)
show that headers and log queries consume different amounts. A headline RPS allowance does
not guarantee that many log queries per second. This account's exact CU/s allocation and
other-app consumption have not been inspected.

The paced transport initially triggered Ponder's build-identity guard because its helper
was placed under `src/`, which Ponder hashes as indexing logic. Moving it outside `src/`
and restoring the unchanged event-source files allowed safe checkpoint recovery. No Ponder
metadata was edited and no projection was discarded to bypass that guard. Failed startup
attempts remain visible in PM2's restart count.

Final uninterrupted four-minute observation (2026-09-10 UTC):

| Time | Chain head | Indexed block | Lag |
| --- | --- | --- | --- |
| 15:21:45 | 59506401 | 59496485 | 9916 |
| 15:23:45 | 59507588 | 59496641 | 10947 |
| 15:25:45 | 59508806 | 59496823 | 11983 |

The chain advanced 2405 blocks, the indexer only 338: approximately 10.0 versus 1.4 blocks/s.
Ponder had reduced its successful request rate to about 3 RPS after 429 responses. During
this final window its error counter stayed at 60, but lag continued growing. Indexer health,
API readiness and reconciler health remained 503. This is **not** a catch-up pass.

Next: enable a provider allowance with adequate CU/s and larger log ranges, or supply another
qualified endpoint. Do not change billing without owner approval. Once available, re-probe
the log-range allowance, synchronize it in both environments, restart without clearing
persisted state, then repeat a several-minute observation. Require shrinking lag followed
by fresh canonical heads, a successful deep reconciliation and both `/ready` and
`/v1/system/readiness` returning 200. Never raise freshness tolerances, fake finality,
advance checkpoints or skip deployment blocks to pass these checks.

## Verification performed

- Solidity suite: 196 passed, zero failed/skipped, including fuzz and invariants.
- Isolated local PostgreSQL/TypeScript suite: 228 passed, zero failed, one opt-in real-token
  fork integration skipped. Tests do not use Aurora; automatic production env loading was
  disabled in the test subprocess launcher.
- Additional deployment recovery tests: 5 passed; pacing tests: 4 passed locally and on EC2.
- Contracts, database and indexer TypeScript checks passed; changed TypeScript formatting/lint checked.
- Fresh indexer contract preflight passed; independent runtime/receipt/zero-fee checks passed.
- Public HTTPS liveness and market reads passed; protected internals stayed inaccessible;
  unauthenticated order submission was rejected. Readiness was explicitly reported as false.
- Both local `/markets` screens and `/api/indexer/markets` returned 200 with real empty data.

No live trade/resolution or live subscribed-market price synchronization is claimed: the
fresh deployment has no markets and its indexer has not caught up. The owner must still
complete governance acceptance; the external audit requirement remains intentionally deferred.

## Deployed source

The server's Git base remains `243d690545c397a04117de79193dadde7cd471f6`. The local main
working tree (including the prior real-only UI and single-admin changes) was deployed as a
source snapshot with the frozen Bun lockfile, not as a new commit. No commit or push was
performed. The previous server checkout is backed up; do not force-reset this deployment.
Subsequent pacing/diagnostic updates are synchronized with the local source.
