# Protocol-wide underlying custody — fresh deployment

Follow-up: [trading-key delegation](trading-delegation-2026-09-18.md) now builds on this custody layer. Its report supersedes the earlier "delegation is separate/not implemented" status and records the additional fresh-ABI changes; this document remains the custody implementation record.

## Scope and deployment status

The Rust program and TypeScript transaction builders now use protocol-wide custody for underlying assets. This is a **fresh-deployment ABI**, not an upgrade/migration path. No live program, wallet, token balance, or service has been changed. This work does not grant an API server permission to sign for users; trading delegation is a separate feature.

This document supersedes the custody assumptions and compute measurements in the earlier cost-remediation report. The earlier report remains a record of that earlier implementation.

## Accounts and ownership

| Account | Seeds | Purpose |
| --- | --- | --- |
| AssetPool | `pool / config / mint` | Immutable mint/program identity and total underlying liability |
| Underlying token vault | `pool-vault / pool` | Actual SPL or supported Token-2022 tokens; pool PDA is authority |
| AssetCredit | `asset-credit / pool / owner` | Owner's available, unreserved underlying balance across all markets |
| Market / Order | Existing market/order seeds | Market-specific backing, risk limits and order reservations |
| Claim mint / vault / Wallet | Existing market-specific seeds | Event-specific YES/NO claims; never fungible across unrelated markets |

There is one token vault **per mint and protocol config**, not one mixed-token account. SOL uses wrapped SOL. Different mints with the same symbol are never combined. Different protocol configs cannot spend each other's deposits.

AssetPool is 114 bytes including discriminator; AssetCredit is 81 bytes. Underlying vaults are no longer created twice per market. Claim vaults and market claim wallets still exist. The two whole-asset slots in Market/Wallet remain as temporary in-instruction accounting scratch space and must be zero in successfully persisted state. They are not a second balance ledger.

## Conservation

For each mint, independently:

```text
vault.spendable_amount >= pool.liability
pool.liability = sum(all owners' available AssetCredit)
               + sum(all markets' underlying order escrow)
               + sum(all markets' conditional-token backing)
```

Only actual deposits and withdrawals change total pool liability. No instruction needs to scan all markets: new pools start at zero; deposits/withdrawals change available balance and total liability by the same amount; every allocation/refund/split/merge/redemption conserves each mint independently. Solana's writable account locks serialize competing uses of the same owner's AssetCredit, preventing concurrent cross-market double spending.

Trading and position operations keep the pool and underlying vault readonly. They validate aggregate solvency, hydrate explicitly supplied canonical credits into the existing checked accounting, prove per-mint conservation, flush changed credits and require zero persisted market/wallet whole balances. No underlying token CPI takes place. Claim mint/burn and custody/supply checks remain market-specific. A missing refund account fails the transaction; funds cannot be silently left in an obsolete market balance slot.

Whole-funded BUY orders can release rounding dust even when resting maker funds were already reserved. Placement includes those makers' global credits and tests eight simultaneous, distinct refund recipients. Self-matches/recipient aliases share a single validated wallet image and credit account; duplicate tail accounts are rejected.

## Instructions and SDK

- `initialize_pool`: permissionless funding of the canonical pool/vault, with mint-extension policy validation. Cannot recreate or overwrite an existing pool.
- `initialize_credit`: permissionless account rent payment, but credit belongs only to its specified owner. Repeated calls never reset available funds. Credits are not closed/reinitialized.
- `deposit_pool(amount, minimum_credit)`: requires the owner signer and owner-controlled source. Credits only the measured net vault receipt; checks exact source debit.
- `withdraw_pool(amount, minimum_received)`: owner-signed withdrawal of available funds only, with exact gross vault debit and a signed minimum net destination receipt. The destination cannot be the vault itself.
- Placement, cancellation, batch cancellation/retirement and position operations use global credits for underlying assets. Claim-token deposits/withdrawals remain market-specific.
- Merge/redemption can create a missing AssetCredit atomically for a claim holder who never deposited that underlying asset. The owner pays rent; failure rolls creation back.

`SolanaClient.depositPool` and `withdrawPool` need no market argument. `assetCredit(mint, owner)` reads the new available balance. Existing asset-indexed SDK operations route whole assets to these new instructions and claims to market custody; this is convenience routing, not old deployed-program compatibility.

Placement/position builders require market mint context: provide an indexed market to `placement`, call `rememberMarket`, or explicitly read `market` once. They do not hide a new RPC behind synchronous transaction construction. `orderMaintenance` takes explicit refund asset indices for potentially open whole-funded orders; completed-only retirement needs none. The ALT provisioning script includes pools, shared vaults and owner credits.

## Token standards and authority boundaries

Classic SPL and the existing explicitly supported Token-2022 extensions remain supported. Transfer fees are measured on deposit/withdrawal only, not on allocation between markets. Withheld transfer fees and unsolicited token donations never become available user credit. Unsupported extension policies remain fail-closed, including permanent delegates and transfer hooks; this is **not universal issuer support**. Issuer freezing and other allowed token risks have not been eliminated.

Pool authority cannot be replaced by a market, trader or API account. Each credit binds the exact owner, pool, program owner, PDA and bump. Withdrawal requires the owner signer even if a different wallet paid account rent. There is no migration endpoint, operator sweep, unrestricted transfer of user credit, or new trading delegate.

## Verification

The following passed locally against the current fresh-deployment implementation:

- Rust workspace host tests, including four new pool suites and 10,000 deterministic randomized reserve/release/flush roundtrips.
- Compiled-SBF accounting/cost and hardening suites, including the existing eight-maker funding/branch/recipient matrix and a new eight-maker global rounding-refund stress case.
- 13 localhost validator integration tests using generated wallets, classic SPL, fee-bearing Token-2022 and wrapped SOL. They check actual confirmed transactions, cross-market balances and aggregate solvency, reservation double-spend rejection, matching without issuer transfers, cancellation/IOC refunds, merge/redemption reuse, claim-recipient first credit creation, fee/slippage minima, freeze rollback, donations, unauthorized withdrawal and malformed/duplicate/readonly/foreign credit accounts.
- TypeScript SDK/application tests, workspace typechecks, Rust formatting and Clippy.

Representative consumed compute units (not SOL fees):

| Operation | CU |
| --- | ---: |
| Resting whole-funded order | 67,359 |
| One whole-funded fill | 107,581 |
| Eight distinct whole-funded makers | 208,636 |
| Eight makers with distinct global rounding refunds | 236,772 |
| Largest ordinary matrix case | 263,345 |
| Split / merge | 49,749 / 50,157 |
| Classic-SPL pool deposit / withdrawal | 26,064 / 26,075 |

Global custody adds identity/conservation work compared with the immediately preceding per-market optimized version; it is not a free compute reduction. Its main benefits are shared deposits, fewer underlying token accounts across markets, and no repeated issuer-transfer fees when changing markets. No claim of exhaustive testing, 100% program coverage, guaranteed lowest fees or freedom from vulnerabilities is made. Independent review remains appropriate before meaningful funds.

Reproduce using the pinned Rust/Agave toolchain:

```sh
cargo test --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
bun run test:costs
bun run typecheck
bun run test:ts
# Load the freshly built program into a disposable localhost validator first:
SOLANA_POOL_TEST_RPC=http://127.0.0.1:8911 bun run test:pools
```

`test:pools` refuses non-localhost RPCs and never loads deployment keys. The CI SBF job now also provisions a disposable local validator for this suite; remote CI has not been run here.

## Required before application deployment

Follow-up: the indexer/database/API/maker integration and actual application runs are now recorded in [the services cutover report](protocol-wide-services-2026-09-18.md). The list below records the original contract-first handoff; fresh deployment and independent review remain required.

This is the requested **contract-first** step, not an end-to-end app cutover. Do not deploy the fresh ABI behind the currently running services until these follow-ups are implemented and verified:

1. Index AssetPool and AssetCredit; handle PoolChange deposit/withdrawal events and credit changes from matching/positions/cancellation. Reconcile global pool liability across all markets and owners. Never count one global available balance once per market.
2. Update API portfolio, balances and reservations, and UI portfolio/funding displays, to distinguish global underlying credit from market claims. Transaction builders alone do not change those data models.
3. Update market-maker inventory/allocation logic and deployment/bootstrap scripts for global pools and fresh config/program addresses.
4. Port the older per-market `local-validator`, `token2022-validator`, application and bot integration harnesses to this layout. They are gated suites and were **not** used as evidence of current fresh-ABI compatibility. The new `test:pools` suite is the executed cross-market custody suite, not a claim that every historical app fixture has been migrated.
5. Provision fresh lookup tables as needed and complete an independent security review and fresh-deployment rehearsal.

No old funds/accounts are migrated or reclaimed automatically.
