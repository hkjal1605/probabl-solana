# CV-01 / CV-02 remediation — 2026-09-12

Status: implemented and locally verified. This is agent-assisted remediation,
not an independent audit, a bug-free guarantee, or permission to use real funds.
The [original comparison](metadao-comparison-2026-09-12.md) and its artifact manifest
remain historical evidence. No MetaDAO implementation was copied or substituted.
Token-2022 admission policy, issuer trust assumptions and governance are unchanged.

## CV-01: independent supply and custody guards

`programs/conditional-stocks/src/invariants.rs` reads fresh canonical claim mint
and vault data before and after split, merge, redemption, and order placement.
It validates mint identity, program, decimals and market-only authority, as well
as vault identity/authority and absence of delegates/freeze/close authorities.
It does not reuse stale Anchor mint-supply fields after CPI.

For each collateral, let `Y` and `N` be **total outstanding mint supplies**,
including claims held outside protocol custody. Required conditional backing is:

| State | Minimum backing |
| --- | --- |
| Unresolved | `max(Y, N)` |
| YES | `Y` |
| NO | `N` |
| INVALID | `ceil((Y + N) / 2)` |

Resolved and archived states use the finalized payout. Calculations use widened,
checked raw-unit arithmetic. The INVALID ceiling conservatively preserves the
backing for an unmatched fractional claim; it never rounds liability down.

Separate checks enforce whole custody >= whole credits + escrow + backing, and
claim custody >= claim credits + escrow + protocol fees. Actual claim supply
and claim-vault balance changes must **both** match the requested mint/burn.
Placement independently accumulates expected mints from validated whole-funded
fills on both collaterals, including multiple makers. Underlying vaults are
read-only for these operations: no issuer transfer or second transfer fee occurs.

External burns and unsolicited donations remain permissible surplus; they do
not become user credits or withdrawable protocol fees. Token-2022 withheld fees
are never counted as spendable custody. Deposits/withdrawals do not mint claims
or change conditional backing and retain their existing net-receipt checks.

Finalized reconciliation now fetches market + six custody vaults + four claim
mints together, in batches of nine markets (99 accounts/request). All comparisons
for a market use the same finalized bank, including supply/authority/decimal
checks and legitimate partially initialized markets. Undercollateralization fails
readiness even when recorded custody liabilities alone appear covered.

## CV-02: exact redemption, no silent fractional burn

Redemption sums weighted YES/NO quantities **before** division. If the result is
not an integer raw underlying amount, `FractionalRedemption` rejects the entire
instruction before burning. Binary winning redemption remains exact; explicitly
burning worthless binary losing claims is still permitted and clearly warned.

| INVALID request, in raw claims | New behavior |
| --- | --- |
| 1 YES + 1 NO | Burn both, credit exactly 1 |
| 11 YES + 19 NO | Credit exactly 15, not 14 |
| 1 YES + 0 NO | Reject; no token/account changes |
| Maximum u64 YES + maximum u64 NO | Exact maximum u64 payout; no sum overflow |
| SDK recovery of 9 YES + 2 NO | Merge 2, redeem 6 YES, credit 5, retain 1 YES |

The SDK's combined redemption builder and merge-first recovery planner fund only
the claims actually needed for burns, including holdings split between internal
credits and external ATAs. An odd INVALID remainder stays an actual owned,
transferable/combinable claim. Repeating a non-executable recovery preview cannot
burn it or deposit it. Matching complete sets can still merge after resolution,
archive and pause, subject to existing program/token restrictions.

The portfolio review displays exact quantities merged, redeemed, burned,
retained, and credited. It signs the locally prepared plan, rechecks canonical
market/payout identity, disables confirmation when nothing can pay exactly, and
warns explicitly before a zero-payout losing-claim burn. The dialog is scrollable
on small screens. Network fees and later issuer withdrawal fees are distinct.

No fractional IOU account, new claim denomination, socialized dust pool or admin
sweep was introduced. Previously burned claims/backing dust are **not** restored
or reassigned. A last unmatched raw claim cannot independently pay half of an
indivisible underlying unit; retaining it prevents value destruction but cannot
guarantee another matching claim will be available.

## Compatibility and compute

- Position instructions append read-only `underlying_vault` after `token_program`.
- Placement appends read-only `base_vault` and `quote_vault` after `system_program`;
  the remaining-account tail format stays unchanged.
- Errors append `ClaimBacking` (6016), `TokenDelta` (6017), and
  `FractionalRedemption` (6018). Existing error numbers and stored account layouts
  are unchanged. SDK and generated IDLs match semantically.
- **Program, SDK/IDL, UI and services require a coordinated rollout.** Old builders
  lack the new required accounts and must not be used. No existing demo or funded
  deployment was upgraded by this task.

The two-maker regression exposed exhaustion of the default compute limit after
the added guards; Solana rolled the entire transaction back. Local SDK transaction
preparation now inserts a deterministic compute-unit limit for filled placements:
`min(1,400,000, 200,000 * original instruction count + 100,000 * fill-leg count)`.
It never accepts an API-provided compute-budget instruction or adds a priority
price. Program instruction bytes remain unchanged, and packet size is checked
after insertion. This follows the documented [Solana compute limits](https://solana.com/docs/core/fees).
The corrected two-maker fill executes successfully below its 400,000-unit limit.
Raw integrations bypassing `prepareTransaction` must request sufficient compute.
The eight-maker protocol cap does not guarantee packet fit; lookup tables and
large-book execution remain separate unfinished work.

## Verification

| Check | Result |
| --- | --- |
| Host Rust + property tests | 25 passed; 100,000 generated cases |
| Compiled SBF validator regression suite | 28 passed / 10,133 assertions; opt-in epoch test run separately |
| Actual Token-2022 fee-epoch transition | 1 passed / 6 assertions |
| Two-maker whole-funded SBF regression | 1 passed / 60 assertions through corrected SDK preparation |
| SBF fault-injection bank | 1 passed: 2 fault types × 4 paths, rollback checks and healthy split/merge control |
| Fast TypeScript | 119 passed / 6,547 assertions; 34 opt-in tests/hooks skipped in this command |
| Fresh Token-2022 application rehearsal | API/admin/indexer authentication, funding, matching, recovery and durable replay: 2 passed / 47 assertions |
| Workspace TypeScript, strict Clippy, Rust formatting | Passed |
| Public UI production build | Passed |
| Read-only browser review | Exact payout/retained claim, disabled odd-claim confirmation, explicit zero-payout warning and mobile dialog bounds verified |

SBF tests include both books/funding combinations, exact odd-pair redemption,
fractional-burn rejection, zero-decimal collateral, external claims and burns,
retained-claim recombination, both fee-bearing collateral mints, archival recovery,
account substitutions, u64 overflow rollback and wrapped SOL. Synthetic bank
faults independently inflate claim supply or reduce custody; split, merge,
redeem and placement all reject them without leaving partial state.

Clean **host** line coverage: core 100% (167/167), new invariant module 100%
(93/93), token policy 100% (23/23), combined **28.38% (435/1,533)**. Custody and
exchange CPI handlers are exercised separately by SBF tests and still report 0%
in host instrumentation. These results do not establish exhaustive branch coverage
or absence of exploitable bugs.

An initial validator setup timed out; its healthy rerun passed. A fast-suite
generated-book test exceeded its five-second timeout while other heavy checks
ran; rerunning with a 20-second limit passed in under two seconds. The two-maker
compute failure was fixed, not dismissed as a test flake. Browser checks used only
synthetic read-only wallet/RPC responses; real transaction behavior was tested
separately on the mock validator. No real wallet was imported or signed with.
Playwright inspection found and prompted the scrollable-dialog fix. Screenshots
are retained in `output/playwright/cv-*-review.png`,
`output/playwright/cv-odd-retained-mobile.png` and
`output/playwright/cv-zero-payout-mobile.png`. The isolated browser session and
temporary validator were closed; the previous demo services were left running.

Artifact: `target/deploy/conditional_stocks.so`, **690,840 bytes**, SHA-256
`1b8b3fa1ce785b47618eb712b88613ca472fa21db6ec9f6a399db63e182540e1`.
The isolated validator's loaded bytes were compared and matched exactly. Ledger:
`.local/cv-fixes-cDWuAd`. Source/artifact hashes are in the adjacent remediation
manifest. Disposable application databases/services are cleaned up; generated
mock fixtures and local verification artifacts are retained.

CV-03/04 issuer/authority concerns, independent review, complete monorepo parity,
deployment controls and the other [security release gates](../../SECURITY.md)
remain open. This remediation does not extend support to every Token-2022 issuer.
