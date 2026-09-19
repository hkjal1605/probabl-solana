# Compute and rent remediation

Historical report: the subsequent [fresh-deployment protocol-wide custody implementation](protocol-wide-custody-2026-09-18.md) changes the custody ABI, artifact and compute measurements. Do not use this report's compatibility statements or artifact hash for that newer implementation.

Implements the compatibility-preserving changes from [the cost audit](solana-cost-audit-2026-09-18.md). No devnet/mainnet upgrade, deployment, rent recovery, or production-wallet transaction was performed. All executed transactions used disposable localhost or program-test fixtures.

## What changed

| Finding | Implementation | Important boundary |
| --- | --- | --- |
| COST-01: heap failures | Lazy error construction instead of allocating Anchor errors on successful arithmetic; one bounded participant vector instead of two maps; allocation-free duplicate checking; serialize each wallet once. | Default 32-KiB heap retained. No custom allocator, unchecked arithmetic, or larger heap request. |
| COST-02: permanent order rent | Nonce-bound salts, `retire_orders` batches, final-order archival events, indexer restoration, SDK helpers, explicit bot rent recovery. | Rent is still paid up front. Recovery requires permanent replay rejection, not merely “filled.” Legacy orders can retire only after permanent market closure/cutoff. |
| COST-03: repeated identities | Validate registered mint identities once; derive each untyped claim vault once; reuse Anchor-validated position vaults; fresh post-CPI token reads. | Total supply/backing, custody, expected-delta, owner and authority checks remain. |
| COST-04: excessive mint CPIs | Preserve per-fill accounting/fees, mint each affected claim once after the loop. | At most four mint CPIs, not four per fill. Fee rounding/carry remains per order. |
| COST-05: simple orders take settlement path | No post-CPI reload when no mint CPI occurred; final liabilities still checked. SDK supplies readonly claim accounts where no mint is needed. | One common instruction avoids divergent accounting/security implementations. |
| COST-06: packets exceed client capacity | Exact budget-inclusive v0 sizing before review/signing, account-count bounds, deployment-configured frozen lookup tables, coalesced cache, operator provisioning script. | No silent splitting or truncation of user matches. Eight makers still require suitable table coverage for some account topologies. |
| COST-07: repeated quote operations / contention | Owner-authorized, idempotent eight-order cancellation batches, eight-order retirement batches, indexed-address SDK construction; remove redundant bot preflight after explicit simulation. | Shared Market write lock intentionally remains: collateral and aggregate risk caps still have one atomic authority. This mitigates repeated transaction work; it does not introduce parallel same-market settlement or claim lock sharding is solved. |
| COST-08: overallocated state | New markets allocate actual immutable metadata length; `compact_market` reclaims unused padding without changing serialized fields. Resolution capacity is preserved until resolution. | No speculative zero-copy migration, separate cold account, hash-only metadata, or reduction in supported URI lengths. |
| COST-09: coarse budgets | Local deterministic profiles by operation/legs/participant count/mint work; explicit zero priority price; reject oversized budget bundles instead of silently capping them. | Base network fees are not eliminated. Profiles have headroom, not a promise to predict every future runtime version. |

The important additional root cause identified during remediation was eager `.ok_or(error!(...))`: Anchor error construction allocated even when the arithmetic succeeded. `.ok_or_else(|| error!(...))` preserves the failure and numeric semantics without consuming heap on success. Bounded containers and CPI consolidation alone were insufficient for the full eight-maker matrix.

## Measured before/after

Same deterministic classic-SPL fixtures and compiled-SBF runtime as the audit. These are consumed CU, not SOL fee quotes. Matrix transactions include a compute-limit instruction; production SDK additionally pins a zero CU price.

| Operation | Before | After | Change |
| --- | ---: | ---: | --- |
| Resting order | 93,801 | 54,412 | 42.0% lower |
| One whole-funded fill | 148,608 | 94,552 | 36.4% lower |
| One claim-funded fill | 118,888 | 68,057 | 42.8% lower |
| Two distinct makers, whole-funded | Out of heap | 108,470 | Now succeeds |
| Eight distinct makers, whole-funded | Out of heap | 194,907 | Now succeeds, 4 mint CPIs |
| Eight distinct makers, claim-funded | Out of heap | 166,354 | Now succeeds, 0 mint CPIs |
| Split | 65,806 | 39,311 | 40.3% lower |
| Merge | 66,206 | 39,723 | 40.0% lower |
| INVALID redemption | 66,785 | 40,302 | 39.7% lower |
| Cancellation | 19,394 | 17,716 | 8.7% lower |

The maximum measured matching case was 248,744 CU: eight makers with separate recipients and long metadata. The suite executes 122 successful workload fixtures, including 96 eight-maker combinations across two branches, two taker directions, four funding combinations, three owner topologies, and separate/shared recipients. It checks an independent exact-unit accounting reference after executing each placement, not just simulation success.

The final release artifact is 705,128 bytes, SHA-256 `194b082f03300c99834c81dc3750b984e7d4e93852b5e7b1431a5556c0524f01`. It is slightly larger than the audit artifact because of new retirement/batch/compaction functionality; executable-size reduction is not claimed. Overflow checks and the original release LTO settings remain enabled.

## Rent and replay protection

New UI and bot orders use a 32-byte salt:

```text
bytes 0..8    "PRBLOv02"
bytes 8..16   exact order nonce, little endian u64
bytes 16..32  random 128-bit suffix
```

All placement through the existing `place` entrypoint enforces this binding when the reserved prefix is present. The PDA remains `order / market / owner / salt`. Existing non-prefixed salts retain their old behavior.

On an open market, retirement requires this salt binding and `order.nonce < trader.minimum_nonce`. Reusing the same salt with its old nonce fails invalidation; changing its nonce fails the salt binding. The Trader account is never closed/reset. Minimum nonce advancement is owner-wide and strictly increasing; it must not be hidden in an ordinary order cancellation or automatically invalidate unrelated open orders.

For non-prefixed legacy orders, expiry alone is insufficient: the same address could be reused with a different expiry. Retirement is allowed only once the market cannot ever open again—cutoff reached or the existing one-way lifecycle has reached FROZEN/AWAITING/REDEEMABLE/ARCHIVED. There is no new reopening path.

`retire_orders` accepts at most eight distinct owner-owned orders in one market, releases any remaining reservations, requires zero remaining/reserved/exposure, emits a complete final account image, and refunds the order account to its recorded owner. A bad later entry rolls back earlier closes/releases. It cannot redirect refunds to an arbitrary recipient.

Per retired Order, the current 0.00246384-SOL deposit becomes recoverable (minus transaction fees). Forty orders can recover about 0.0985536 SOL. This is recoverable rent, **not zero upfront trading cost**. ProgramTest verifies exact rent refunds and unchanged nonpayer state on failures.

`OrderRetired` events are replayed only from successful finalized program invocations. Indexer and API restore those records into historical order maps, never the live RPC account image, and reject archived records that remain open or have reservations. This preserves fill ownership/cost-basis reconstruction when an account no longer exists. Deploy the event-aware indexer before allowing retirement. Archival RPC/history retention remains necessary, as before.

## Market padding recovery

All Market fields and discriminators remain unchanged. Allocation is:

```text
1825 - 1024 + metadata_uri UTF-8 byte length + evidence capacity
```

Evidence capacity stays 512 bytes before resolution and can shrink to actual evidence byte length afterwards. Metadata and evidence limits stay 512 bytes each. A 100-byte metadata URI therefore saves 412 bytes / approximately 0.00286752 SOL compared with the old allocation. Existing markets can use `compact_market`; only the market-admin role may invoke it. The refund is exactly the released rent minimum, and unrelated lamport donations are retained. Repeated compaction is safe and refunds zero when nothing more can shrink.

No existing order, wallet, config, trader, or market layout migration is needed. Do not shrink claim vaults/mints or close wallets/Trader state to chase additional rent savings without a separately reviewed design.

## Lookup tables and client budgets

Set the same comma-separated table addresses in backend/bot `SOLANA_ADDRESS_LOOKUP_TABLES` and UI `NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES`. The SDK accepts up to eight configured tables, requires active/frozen state, and shares in-flight/successful reads across client instances for the same RPC/network/configured list. Failed reads are evicted. Frozen tables cannot be extended/deactivated; their immutable images can be cached without per-review table fetches.

The API checks packet size during review using indexed order data and cached table images—no added order, wallet, vault, or balance RPCs. The SDK checks again against the exact bundle before requesting a blockhash/signature. Tables compress addresses, not instruction data, compute, or account locks. [Solana's lookup-table documentation](https://solana.com/developers/cookbook/transactions/lookup-tables)

The provisioning helper is `scripts/solana/create-lookup-table.ts`. It requires `--execute`, an explicit keypair file (`SOLANA_PAYER_KEYPAIR`), deployment RPC/config/genesis, `LOOKUP_TABLE_MARKETS` (comma-separated; singular `LOOKUP_TABLE_MARKET` also supported), and optional `LOOKUP_TABLE_OWNERS`. Include regular maker owners so their Wallet/Trader accounts are covered. It validates markets, adds market/vault/mint/participant addresses, extends in bounded chunks, then irreversibly freezes the table. More than 256 unique addresses requires separate tables. Frozen table rent is intentionally not reclaimable.

No lookup tables were provisioned on devnet/mainnet during this work. Without appropriate tables, oversized matches fail early with an actionable message rather than reaching the wallet or partially executing.

## Operator cleanup

SDK methods:

- `orderMaintenance("cancel_orders", market, owner, addresses)`: up to eight owner-owned orders; already filled/cancelled entries are idempotent so concurrent fills do not poison emergency cancellation.
- `invalidateNonce(owner, minimum)`: explicit owner-wide invalidation; never call casually to clean one order if other lower-nonce orders must stay live.
- `orderMaintenance("retire_orders", market, owner, addresses)`: safe rent recovery under the rules above.
- `compactMarket(market, admin)`: recover safe Market padding.

The bot has an explicit `--reclaim-rent` mode (alongside the existing `MM_MODE=live` and `--execute` gates). It requires that the wallet have **no open orders across any market**, advances the nonce for completed bound-salt orders, then retires eligible orders in batches. It does not run silently inside the quoting loop. Cancel first when intentionally stopping/restarting liquidity; legacy orders on still-open markets remain until market closure. Refunds do not increase the bot's daily spending allowance. No production bot was restarted or cancelled during this task.

## Verification and rollout

- Host Rust tests and property suites; strict Clippy and formatting checks.
- Fresh compiled-SBF success/cost gates, independent balance/fee/supply/escrow reference checks, retirement authorization/replay/rollback/refund checks, compaction identity/donation checks, and existing collateral/supply hardening tests.
- Full classic-SPL and Token-2022 local-validator lifecycle suites.
- TypeScript tests for lookup sizing/cache, readonly account flags, nonce-bound salts, historical reconstruction, wallet message immutability, and bot transaction safety.
- Localhost market-maker lifecycle, funding, fill, replacement, cancellation batching, and rent recovery.

Final local results: 25 host Rust tests passed; all four explicitly enabled compiled-SBF tests passed (including 122 cost/accounting fixtures); all 30 classic-SPL/Token-2022 validator tests passed with 10,199 assertions; the bot validator lifecycle/rent-recovery test passed with 16 assertions. The application suite passed 412 tests, with 44 environment-gated tests skipped and zero failures. Validator suites among those skips were executed separately as described above; PostgreSQL/Redis-dependent integration tests were not executed against a live service. Workspace typechecking, strict Clippy, Rust formatting, generated-IDL equivalence, and whitespace checks passed. An existing `proc-macro-error2` future-compatibility warning remains.

`bun run test:costs` builds a fresh temporary SBF artifact and runs the VM gates. The GitHub workflow adds a compiled-SBF job with Agave 3.1.10's verified Linux release digest and platform-tools v1.52. The workflow has been added and locally inspected; it has not been executed on GitHub in this task. Native successful unit tests alone are not sufficient to approve a program upgrade.

Deployment sequence, requiring a separate approved rollout:

1. Review these changes and reproduce the host, VM, and local-validator results. Perform an independent security review before production value is exposed.
2. Deploy the event-aware indexer before any retirement event is emitted. Verify finalized replay and historical order reconstruction. Keep the existing API transaction builder and trading clients until the coordinated upgrade window.
3. Pause transaction submission for the coordinated rollout, upgrade the program, and verify its deployed binary. Check available ProgramData capacity because the binary grew slightly.
4. Provision/configure appropriate frozen tables, then deploy the API, clients, and bot with the new IDL, historical reconstruction, readonly placement accounts, and measured budgets before resuming submission. Do **not** ship these transaction changes against the old binary: its writability checks and larger CU needs differ.
5. Exercise deposit, trade, cancellation, merge, redemption, and a small explicit retirement batch on devnet before broader use. Run optional market compaction and bot cleanup only with deliberate owner/admin signatures.

These changes reduce measured resource use and remove the reproduced failures. They do not prove a theoretical minimum cost, eliminate network fees/initial rent, remove global market serialization, or replace an independent security audit.
