# Internal RH mainnet testing — deployment and operations

This is a fresh deployment: there are no historical funded contracts to migrate. On 2026-09-07 the owner explicitly accepted deferring audit M-02 and the 11 transitive dependency advisories for **internal testing only**. Neither is fixed, independently audited or approved for public production. No tool in this implementation task broadcasts to RH mainnet.

## Supported topology

Use one supervised Bun process per API, Ponder indexer, reconciler and Polymarket ingestor. All services share one PostgreSQL writer database with separate operational and Ponder-managed schemas. Follow the [shared PostgreSQL runbook](shared-postgres.md) for migrations, privileges, backups and pool budgets. Run the public and admin Next.js applications as separately supervised production builds. Keep indexer, reconciler and ingestor `/internal/*` endpoints on loopback/private networking. Only expose the intended frontend routes and the ingestor's public probability WebSocket through HTTPS/WSS. Administrative access remains restricted to authorized operators; trading does not require a tester-wallet allowlist.

Use the indexer package launcher, not the bare Ponder CLI. Include the committed `patches/` directory
and run `bun install --frozen-lockfile`. The launcher pins Ponder 0.17.8, isolates its disposable sync
cache by deployment schema and runs bounded maintenance outside block handlers. Keep the same
`DATABASE_SCHEMA` and `INDEXER_BLOCK_RETENTION` on restart. See the [storage policy](../../services/rh-indexer/README.md#bounded-idle-storage-and-durable-restarts)
for retention settings, alerts and replay requirements. No existing schema or legacy shared cache
is automatically removed during rollout.

The onchain exchange remains permissionless. The trading API accepts any authenticated wallet, subject to order ownership, funding and trading safety checks; it does not whitelist tester addresses. Use only disposable developer-funded accounts, small balances and approvals, active supervision and an explicit loss budget. Open-order caps are not cumulative exposure limits. Cheap gas does not cap loss.

## Environment and secrets

Use `LOG_LEVEL=info` for backend operational logs and `NEXT_PUBLIC_LOG_LEVEL=info` when building each UI. Switch to `debug` for internal polling/feed diagnostics. See [database and logging](../architecture/database-and-logging.md) for event names, redaction, request IDs and storage ownership; logging introduces no external credential requirement.

Use the root `.env.example` for service settings, `packages/contracts/.env.example` for the deployment signer, and each UI's `.env.example` for frontend builds. Use absolute storage and manifest paths. Inject only the credentials each process needs; never supply deployment/admin keys to long-running services or put secrets in `NEXT_PUBLIC_*`.

For RH mainnet set these in deployment/verification and API environments:

```dotenv
EXPECTED_CHAIN_ID=4663
ROBINHOOD_CHAIN_ID=4663
DEPLOYMENT_MODE=internal-mainnet
INTERNAL_MAINNET_RISK_ACK=I_ACCEPT_M02_AND_DEPENDENCY_RISK_FOR_INTERNAL_TESTING
```

`EXPECTED_CHAIN_ID` is used by contract scripts. No tester-address configuration is required or enforced, including on chain 4663; wallet authentication and order ownership checks are unchanged. Gather archive-capable `ROBINHOOD_RPC_URL`, optional RPC `ROBINHOOD_WS_URL`, `DATABASE_URL`, the distinct deployment/governance/operational role addresses (no matcher), independent high-entropy internal tokens, TLS hostnames and persistent storage. Token metadata is read from chain; there are no decimal-scaling environment overrides.

Set `INDEXER_FINALITY_MODE=rpc-tags` on RH. `INDEXER_CONFIRMATION_MODE=safe` waits for the RPC safe tag (bounded by indexing and configured depth); `finalized` waits longer, and `sequencer-depth` explicitly accepts sequencer-stage confirmation while still reporting finality from the finalized tag. Missing/invalid tags fail closed. `local-depth` is for Anvil only, checked by indexer preflight. Depths of 2/30 are not Ethereum finality.

`INDEXER_MAX_HEAD_AGE_SECONDS=30` bounds chain-projection freshness. Every order quote and transaction preparation checks the indexer and reconciler; safety-service failure is a retryable stop, not permission to trade. The defaults are `RECONCILIATION_MAX_AGE_MS=120000`, `RECONCILIATION_MAX_DEEP_AGE_MS=90000000`, and `SAFETY_REQUEST_TIMEOUT_MS=5000`. Monitor these against actual RPC/L1 latency. Reconciliation must complete an initial deep run before trading becomes ready.

Use `RECONCILIATION_URL=http://127.0.0.1:42070`, `INDEXER_API_URL=http://127.0.0.1:42069`,
and `POLYMARKET_INGESTOR_URL=http://127.0.0.1:42073`. Configure the shared `DATABASE_URL`
and a high-entropy `POLYMARKET_INTERNAL_TOKEN`. There is no matcher/settlement-worker
process, internal token, callback URL, gas wallet or relayer private key.
Set `ATOMIC_ORDER_ROUTER_ADDRESS` to the verified new router in the service environment.

Build UIs with chain ID `4663`, the actual contract addresses, browser-safe RPC, and `NEXT_PUBLIC_POLYMARKET_STREAM_URL=wss://<your-probability-host>`. That stream URL points to our ingestor, not the upstream Polymarket socket. The public UI defaults to live mode and never falls back to dummy markets. Its explicitly selected [demo mode](ui-demo-mode.md) is isolated from live services; the former `NEXT_PUBLIC_ENABLE_PREVIEW_DATA` flag is obsolete. Set `NEXT_PUBLIC_ATOMIC_ORDER_ROUTER_ADDRESS` along with the exchange/CTF addresses in the public UI build. Admin health uses the API, indexer, reconciler and ingestor. Ordinary stock reference pricing is deliberately unavailable without a separate verified feed; Polymarket probability is informational and is not required to execute a local stock order.

## Deployment/start order

1. Freeze the release source/lock/artifacts and run the complete verification campaign. Review all deferred risks, canonical token implementations/issuer policies, custody constraints, test wallets and loss limits.
2. Run `deploy:v2` with the explicit internal-mainnet policy. Record the generated manifest. Verify explorer sources, exact deployed runtimes, wiring and role separation.
3. Complete the two-day default-admin handover and run `verify:v2` with `DEPLOYMENT_MANIFEST`. The experimental mode does not remove this delay or weaken bytecode verification.
4. Set all service contract addresses, the earliest protocol `DEPLOYMENT_BLOCK`, and `INDEXER_DEPLOYMENT_MANIFEST` from that verified deployment. Provision the shared PostgreSQL database, run `bun run db:migrate` as migration owner, then apply the service-specific privilege groups. Use a fresh Ponder projection schema.
5. Start `bun run start:indexer`, then `bun run start:reconciler`. Wait for successful deep reconciliation.
6. Start `bun run start:polymarket` and `bun run start:api` with their service-specific environments.
7. Build both UIs with their final public configuration; start `bun run start:ui` and `bun run start:admin-ui`. Complete reviewed market creation and ingestor subscription through the admin evidence workflow.
8. Verify API `/ready`, indexer `/indexer/health`, reconciler `/health`, actual source ticks and browser wallet actions. Health liveness alone is not a trading greenlight.
9. Run small GTC/IOC trades, cancellation, settlement confirmation, all payout/claim recovery workflows, stop/restart rehearsals and a clean indexer rebuild on the selected infrastructure before expanding the experiment.

Commands are individual supervised processes, not one shell that runs them sequentially to completion. Do not run development hot reload/codegen alongside an acceptance run. Back up the entire shared PostgreSQL database, including recovery outboxes, authentication and evidence bytes. Trading keys remain in user wallets.

The public UI also supports [Cloudflare Workers](ui-cloudflare-workers.md); do not run both hosting recipes for the same release. The self-hosted UI build/start scripts use Next's standard self-hosted server (`next build`, then `next start`), not a standalone bundle. Deploy the release workspace with installed dependencies and each application's `.next` and `public` directories. Do not copy only `.next/standalone` from an earlier build. Public build-time variables require a rebuild when changed.

## Recovery and limitations

The [atomic placement specification](../architecture/atomic-placement.md) is the current execution model.
The API quotes eligible makers in price/FIFO order, simulates the exact plan, and returns calldata.
The UI checks those bytes locally and the user's wallet pays gas for a single placement/fill
transaction. Approval may require an earlier transaction. No backend process signs trading calls.

A stale maker remainder/cancellation/expiry or an invalid leg reverts the entire placement,
including earlier fills and fees. Refresh and review the quote; never automatically strip a
failing maker or fall back to rest-only placement. Plans are capped at 32 makers. Contracts
do not enforce best-price/FIFO or completeness. Checked first-party quotes bind the admission
sequence and fee rates, so a normal concurrent admission invalidates the losing quote.
Unrestricted external calls and reorgs restoring older liquidity can still leave crossed
resting orders; no background service clears them. The remaining GTC quantity is available
to later incoming takers. IOC releases its unfilled reservation in its placement transaction.

Rejected individual payouts/refunds become beneficiary-owned credits in `PayoutVault`;
successful payouts are delivered in the same transaction. See [direct recovery](direct-recovery.md)
for partial withdrawal to an alternate address. Final-state open-order caps permit fully
matched orders at a saturated cap; up to 32 stale reservations can be released in the same
checked call when needed. More cleanup requires explicit recovery transactions.

Deploy a fresh complete contract graph, including the exchange-created payout vault. Set
`PAYOUT_VAULT_ADDRESS` for API/indexer/reconciler and build the UI with
`NEXT_PUBLIC_PAYOUT_VAULT_ADDRESS` and `NEXT_PUBLIC_POSITION_ROUTER_ADDRESS`. Execution
version is 2, reconciliation projection version is 3, and the signed-order domain remains 3.
Rebuild Ponder into a fresh namespace for the new credit table/indexes, retaining the same
shared PostgreSQL database and operational schemas. Follow the [hardening record](../architecture/atomic-hardening.md).

Already-broadcast transactions may mine after a freeze. API safety gates block new quotes/transaction preparation, not transactions already in the network or direct user calls. Cancellation/merge/redemption are deliberately not blocked by offchain safety checks. A stalled nonce or issuer-blocked token requires supervised recovery; preserve the exact transaction, receipt and recovery records.

The isolated verification script is `bun packages/contracts/scripts/verify-internal-stack.ts`; `--hold` retains owned local services for browser checks until interrupted. It always initializes an owned loopback PostgreSQL instance (PostgreSQL binaries are required on PATH). Add `--production-ui` to build/serve both production UIs. It uses Anvil chain 31337, public development keys and mock tokens. The separate real-token RH Anvil fork tests remain necessary. Neither test replaces validation of the supplied PostgreSQL, archive provider, reverse proxy, Safe signing setup, browser wallet extension or actual RH sequencer behavior.

Run `bun services/polymarket-ingestor/scripts/verify-live-source.ts` for a read-only Gamma/CLOB/upstream-WebSocket smoke. It submits no Polymarket orders. An ingestor liveness response does not imply every tracked condition has a valid two-sided book; inspect the per-condition quality and source timestamp.

A reorg that removes a previously observed placement must be reconciled against canonical receipts and indexed orders. Refresh quotes only after Ponder converges and deep reconciliation is clean. The API does not rebroadcast trades; the user wallet owns pending transaction replacement. Preserve evidence and follow the reorg runbook. Shared PostgreSQL does not itself prove unattended HA or Aurora failover performance.
