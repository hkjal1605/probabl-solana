# Protocol-wide custody: application cutover

Date: 2026-09-18. Fresh-deployment implementation; no live services, database, wallets, or contracts were modified by this work.

## Ownership and accounting

All PostgreSQL schemas, SQL, migrations, transactions, advisory locks, connections and disposable/local database lifecycle helpers live in `packages/db`. Services receive named operations, not a raw connection or generic query method. This includes API authentication, admin evidence/attachments, history, wallet projections and custody snapshots. The database-boundary tests scan applications, services, packages and scripts.

Schema version 3 separates:

- `solana_asset_pools`: one underlying asset pool per deployment/mint.
- `solana_asset_credits`: one available balance per pool/owner.
- `solana_market_claims`: individual YES/NO balances per actual market/owner/claim asset.

Amounts remain exact decimal strings backed by PostgreSQL `numeric(20,0)` with unsigned-64-bit bounds. No balance calculation converts to a JavaScript floating-point number. Snapshot publication is atomic and rejects older slots. Quiet snapshots advance the watermark without rewriting custody rows; changed images replace normalized rows in bounded bulk statements inside the same transaction. Domains isolate genesis/program/config deployments. A failed stale indexer cannot mark a newer committed image unhealthy.

The indexer proves, from one finalized program-account image:

```
pool liability = all owners' available global credit
               + all markets' underlying order reservations
               + all markets' conditional backing
```

Persisted underlying amounts in market/wallet balance slots must be zero. Claim credits and order escrow must reconcile separately to their market. Expired and revoked orders retain reservations until on-chain release; expiry alone never makes collateral withdrawable.

External custody checks read each pool together with its token vault, and each market together with its claim vaults/mints, in the same RPC bank. They do not compare an old liability against a newer token balance. Global pools are checked once, not once per market. Claim supply/backing, canonical identities and token authorities remain checked.

History scans the program address, not just the config account: pool transfers and some delegation/cancellation instructions do not include config. Global pool/delegation events have a nullable market rather than a fabricated market address. Events are filtered to the deployment and atomically deduplicated with their replay cursor.

## Application semantics

- Wallet balances expose `canonicalBalance` (external ATA), `vaultAvailable` (unreserved global credit), `reserved` (whole-funded open orders across markets) and `creditBalances` (market-specific claims only).
- Portfolio totals count shared credit once. Quote-asset YES/NO positions remain separate by actual market, even for sibling markets sharing a Polymarket event.
- Wallet projections derive credits/reservations from the indexed program image. External token reads are batched and cached; changing indexed credit does not force those reads again. `blockNumber` and `externalBlockNumber` distinguish their watermarks. External balances are display/funding estimates, not authority to spend vault credit.
- Vault prepare routes require explicit global or market scope. Global deposits/withdrawals need no market. Market claim deposits/withdrawals accept only that market's conditional mints; a first claim deposit initializes its owner market wallet. Reserved funds and another owner's credit cannot be selected. On-chain owner signatures remain mandatory for deposits and withdrawals.
- Indexed cancellation builders do not refetch order and market accounts via RPC. Current issuer transfer-fee metadata still requires RPC where necessary.
- Maker funding consumes available global credit first, deposits only the deficit and splits into the selected market. It does not count a shared balance as conditional inventory in every market. Fee limits and ambiguous-send recovery restrictions remain enforced.

Supported SPL and Token-2022 policies remain those of the program. Fee-bearing deposits credit measured net receipts; withdrawals preserve signed minimum receipts. This does not add universal issuer/extension support. Claims stay market-specific classic SPL tokens.

The portfolio and Funds UI now distinguish external wallet tokens, available global vault credit, market-specific claim credit and reserved order collateral. Portfolio value and the order ticket's tradeable balances use only vault credit. External claims can be deposited back to their market from Manage. A deposit or withdrawal uses one explicit wallet transaction; an already deposited balance can be reused across markets. Cancelling or filling an order updates vault credit through the on-chain program and subsequent indexer projection. The ticket never silently deposits or wraps assets when placing an order. Native SOL wrapping, when needed for a deposit, is an explicit locally constructed prefix to the verified pool transfer.

The UI exposes a separate one-time, 90-day, trading-only on-chain grant. The user chooses per-order and lifetime quote-token limits; the dedicated delegate cannot withdraw, settle or change those limits. The lifetime allowance is consumed at order placement even if the order is later cancelled. The API holds only its dedicated fee-paying trading key, checks the authenticated owner and grant, independently reviews and simulates each order, journals the signed transaction before broadcasting, and returns the same signature for repeated requests. It imposes a 500-submission/day/owner limit. A trade uses an authenticated HTTP request after approval and no wallet transaction popup. Revocation is a wallet transaction and does not cancel existing orders. A grant is immutable and cannot be reused after expiry/revocation/exhaustion; deployment operators must rotate the dedicated key and publish its new address before users can grant again.

## Fresh deployment procedure

1. Deploy the reviewed fresh program/config and provision its assets, markets and address lookup tables. Do not run this release against the old per-market program layout.
2. Provision an empty PostgreSQL database (or deliberately configured empty schema). Run both database-owned migrations with the migration owner's credentials:

   ```sh
   bun run db:migrate:solana
   ```

   This creates the Solana service schema. The Polymarket ingestor initializes its separate source-data tables on startup. Legacy custody tables are refused, not automatically altered or deleted.
3. Grant runtime users the needed read/write permissions, not schema ownership or DDL permissions. The API needs reads of committed snapshots/history plus writes to authentication, admin-evidence and delegated-submission journal tables. The indexer needs reads/writes to snapshots, normalized custody, wallet snapshots, events and cursors. Both read the schema-version table.
4. Configure the same fresh genesis/program/config domain for API, indexer, maker and browser configuration; configure the fresh ALT addresses for transaction builders. Give the API a dedicated, funded, non-admin `TRADING_DELEGATE_PRIVATE_KEY` and pin `TRADING_DELEGATE_ADDRESS` to its public key. Store the secret only on the API host/secret manager, never in the browser or committed env files. Restart the indexer first and wait for reconciliation/readiness, then the API and dependent clients.
5. Do not reuse old maker funding journals or evidence as proof of funding for a fresh deployment. Complete a deployment rehearsal and security review before meaningful funds.

The local dev runner now invokes both migrations before launching services. Runtime API/indexer startup verifies the schema only; it never creates tables.

## Verification

Local verification on the existing freshly compiled program:

- 431 fast TypeScript tests passed; 75 environment-gated tests skipped. Skips are not passing coverage.
- Focused database-boundary/PostgreSQL tests passed three tests, including transactional rollback, exact values above 2^53, domain isolation, monotonic snapshots, event deduplication, single-use authentication, delegated-submission journaling and legacy-schema refusal.
- Real API + indexer + PostgreSQL + localhost-validator application runs passed for classic SPL and fee-bearing Token-2022: two tests per run. They cover admin creation/settlement, user authentication, funding, fills, indexing, withdrawals and replay, plus reservations in two markets from shared USDC, market-claim isolation, claim redeposit, delegated trading and cancellation refunds.
- Focused tests cover global withdrawal authorization, mismatched claim mints, cache reuse on indexed balance changes, and maker reuse of shared funds with only shortfall deposits.
- Workspace TypeScript checks, main UI/API production builds and diff whitespace checks pass.

The application harness uses generated wallets and generated localhost databases. It closes its owned API/indexer processes and removes only those generated databases. It does not load deployment wallet keys. CI now includes the database checks and both application token variants alongside the existing pool/delegation validator suites; remote CI has not been executed here.

One final rerun on a long-running validator with its default 10,000-shred retention failed when history was pruned. The indexer correctly refused to advance across that gap. Use a fresh local validator with `--limit-ledger-size 2000000` for the combined suites; CI includes this retention setting. This does not relax production history completeness checks: a lagging deployment whose RPC has pruned its required history needs archival recovery.

The latest fresh-ledger reruns passed with that setting: SPL and fee-bearing Token-2022, each two full-stack tests / zero failures. They include owner-approved trading delegation, exact delegated placement, idempotent retry, refusal of changed terms with the same salt, and revocation.

Older standalone gated validator/bot fixtures are not claimed as additional passing coverage. Previous Rust/SBF/delegation verification is recorded in the linked contract reports; no Rust program changes were required for this application cutover. These tests are not a guarantee of exhaustive edge-case coverage or absence of vulnerabilities.
