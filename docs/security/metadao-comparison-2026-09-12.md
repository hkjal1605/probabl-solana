# Conditional vault comparative review — 2026-09-12

Historical baseline: the findings, behavior and artifact below describe the
pre-remediation review. **CV-01 and CV-02 have since been addressed**; see the
[remediation and verification record](cv-01-02-remediation-2026-09-12.md).
The original manifest is retained unchanged. Other release gates remain open.

Status: source-level review and regression testing of the custom implementation,
not an independent security audit, formal verification, or approval for real funds.
No demonstrated unbacked-minting, double-redemption, arithmetic wraparound, or
unauthorized-custody withdrawal was identified in this review. The open concerns
below remain; this does **not** mean there are no exploitable bugs.

The custom program is retained. No MetaDAO code was vendored, linked, or substituted.
Production instruction semantics, account layouts, token admission and UI behavior
were not changed. Changes are tests, a test-only arbitrary-precision dependency,
and this review record. See [SECURITY.md](../../SECURITY.md) for release gates.

## Reference and reviewed scope

The reference is MetaDAO's `conditional_vault` crate, version `0.4.0`, pinned to
commit `1a8d0d7359ba6f869b84a60b1d709e85ad263ba0` in its official
[programs repository](https://github.com/metaDAOproject/programs/tree/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault).
This is a source pin, **not** verification that a mainnet deployment contains
these exact bytes, and not an audit of MetaDAO itself.

Read the reference crate's manifest, entrypoints, instruction modules, common
account validation, question/vault state, metadata instruction, errors and events.
Locally, read every production Rust source file in `crates/protocol-core/src` and
`programs/conditional-stocks/src`, including all instruction account constraints
and helper paths. Checked the adjacent SDK instruction construction, existing
validator tests, indexer reconciliation and redemption disclosure where relevant.
This is not an end-to-end security review of every API, UI, dependency or operator.

| Area | MetaDAO reference | Custom implementation / review result |
| --- | --- | --- |
| Identity and authorities | [Common accounts](https://github.com/metaDAOproject/programs/blob/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src/instructions/common.rs) bind question, vault, underlying and signer-owned claims | Market/config PDAs, exact registered mints, vault PDAs and owner-bound credit wallets. Exchange additionally validates and deduplicates its entire remaining-account tail. |
| Token programs | [Vault initialization](https://github.com/metaDAOproject/programs/blob/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src/instructions/initialize_conditional_vault.rs) uses classic SPL accounts/program | Underlying custody supports canonical classic SPL and an explicit Token-2022 subset. Outcome claims remain classic SPL, with market-only mint authority and no freeze authority. |
| Split | [Split instruction](https://github.com/metaDAOproject/programs/blob/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src/instructions/split_tokens.rs) transfers underlying and mints a complete set | `custody::split` consumes existing whole-token credit, increases backing and mints equal YES/NO amounts. Whole-funded trading performs the same conversion in `exchange::settle_asset`; it is a second minting path and was included. |
| Merge | [Merge instruction](https://github.com/metaDAOproject/programs/blob/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src/instructions/merge_tokens.rs) burns a complete set and transfers underlying | `custody::merge` debits/burns equal claims and exchanges backing for whole-token credit exactly. Withdrawal is separate. Our merge remains permitted after resolution and archival. |
| Redeem | [Redemption instruction](https://github.com/metaDAOproject/programs/blob/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src/instructions/redeem_tokens.rs) burns all supplied user outcome balances and divides their weighted sum once | Our user specifies quantities; only those credited quantities are burned. Each outcome is floored separately. YES/NO winners are exact; INVALID has the dust behavior discussed below. |
| Resolution | [Resolution instruction](https://github.com/metaDAOproject/programs/blob/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src/instructions/resolve_question.rs) has a signer-bound oracle and one-time nonzero payout denominator | Our market-admin commitment and resolution-admin reveal bind program, config, market, payout, evidence and URI. Only YES, NO and INVALID vectors are allowed, once. This does not verify real-world truth. |
| Global backing | [Vault invariant](https://github.com/metaDAOproject/programs/blob/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src/state/conditional_vault.rs) checks backing against outstanding supply | Our deposit/withdraw paths and indexer check recorded custody liabilities, but do not independently compare total claim-mint supply with backing. The added test oracle checks both layers. Runtime hardening is still open. |

## Open concerns and design differences

### CV-01 — Missing independent runtime supply/backing invariant

Classification: defense-in-depth gap; no demonstrated exploit. Open recommendation.

Locations: `custody.rs` (`split`, `merge`, `redeem`, mint/burn helpers),
`exchange.rs` (`settle_asset`), `services/solana-indexer/src/reconcile.ts`.

Split/merge/redeem and settlement currently trust their checked accounting changes
and successful canonical-token CPIs. Unlike the reference, they do not reload all
claim supplies and assert exact mint/burn deltas or a global backing bound.
The indexer's balance checks also trust the recorded `backing` field. A future
accounting regression could therefore escape the existing readiness checks even
if all six vaults covered their *recorded* liabilities.

The new `validator-invariants.ts` oracle measures actual outstanding claim supply,
including claims outside protocol vaults, and checks it alongside aggregated
wallet credits, order reserves/exposure, fees and spendable custody. All exercised
transitions must preserve both layers. This test helper is not called by the
production program or indexer and must not be presented as a runtime fix.

Recommended follow-up: add explicit post-CPI delta/supply checks to **both** minting
paths and burning paths, and extend same-bank finalized reconciliation to fetch
the four claim mints. Keep credits and escrow separate from conditional backing.
Account lists, compute/packet budgets and failure recovery need review before
changing live instruction interfaces. Unsolicited donations and external burns
must remain allowed surplus, not automatically claimable protocol fees.

### CV-02 — INVALID redemption can irreversibly strand raw-unit value

Classification: existing economic/UX limitation, not an overpayment exploit.
The intended per-outcome rounding policy was not changed during this review.

Location: `crates/protocol-core/src/lib.rs::redemption`, called by
`custody.rs::redeem`. The UI permits individual-branch redemption and discloses
rounding, but does not automatically merge matching complete sets first.

For raw claim quantities `Y` and `N`, INVALID pays `floor(Y/2) + floor(N/2)`.
The aggregate approach pays `floor((Y+N)/2)`. They differ by one raw underlying
unit exactly when both quantities are odd. Redeeming just one raw claim burns
it for zero. Repeated fragmented redemption can strand more dust cumulatively;
"one raw unit" is a per-call comparison, not a lifetime bound.

Example: split one raw underlying unit, then redeem the resulting one YES and
one NO during INVALID. Both claims burn and the payout is zero; the unit remains
unrecoverable backing. Merge the pair instead and the payout is exactly one.
For a zero-decimal mint, a raw unit is a whole token, not necessarily negligible.

Recommended follow-up: explicitly approve the intended economics, show exact
payout/zero-return warnings, and offer merge-first recovery. Changing the contract
to aggregate flooring would be a product-semantic change, not just an overflow
fix. The new property tests prove the difference and the merge-first equivalence
for the supported payout vectors.

### CV-03 — Issuer restrictions and mutable authorities remain release gates

Classification: trust/compatibility boundary, not solved by a conditional vault.

Fee-bearing Token-2022 deposits credit only the net increase in public spendable
balance. Withheld issuer fees are not backing. Withdrawals debit gross credits and
check the signed minimum recipient amount. Internal split/merge/redeem does not
move the issuer token and should not apply its transfer fee a second time.

Permitted mint freeze authorities can still halt external transfers, while
internal classic claims do not inherit issuer freezes or eligibility rules.
An issuer can change allowed transfer fees to make exit expensive or uneconomic.
Hooks, permanent delegates and other unsupported mint behavior are rejected.
There is no support/certification for all stock and RWA issuers; follow
[TOKEN_COMPATIBILITY.md](../TOKEN_COMPATIBILITY.md) before any real listing.

### CV-04 — Deliberate lifecycle and authority tradeoffs

Classification: documented operational assumptions, not a new bypass finding.

- Our split/merge is allowed while paused and after resolution; the reference
  disables both after resolution. The accounting remains backed in the tested
  sequences. Repeated post-resolution splitting can exhaust a losing mint's u64
  supply. The new boundary regression checks atomic rollback and continued
  withdrawal/loser-burning recovery, not perpetual mint availability.
- An incorrect unrevealable resolution commitment can strand unpaired claims in
  the awaiting-resolution state. There is no administrative override. Operators
  must verify the exact reveal before committing; complete-set recovery remains.
- Resolution roles can approve a factually wrong result. Config role/fee changes
  are immediate; only the config-admin handoff has a two-day delay. An upgrade
  authority, if retained in production, is an additional trust boundary.
- On-chain execution validates the signed maker plan, not global best-price/FIFO
  completeness. Caps constrain resting-order exposure, not total collateral or
  Sybil-resistant portfolio risk.

## Accounting argument checked against implementation

For each underlying asset, let `B` be recorded backing, `C` total available whole
credits and `E` whole order escrow. Spendable underlying custody must be at least
`C + E + B`. For each claim asset, custody must cover the sum of claim credits,
claim escrow and protocol claim fees. Token-2022 withheld balances do not enter
either equation.

Before resolution, require `B >= max(YES total supply, NO total supply)`. After
resolution, the test oracle conservatively requires
`B >= ceil((YES supply * y + NO supply * n) / (y+n))`. Using a ceiling also covers
our post-resolution complete-set merges; using total mint supply includes claims
held externally. These bounds are inductive accounting checks, not formal proofs
of the whole program or of dependency correctness.

- A deposit increases spendable custody and available credit by the same net
  amount. Withdrawal reduces both by the gross debit, independently checking the
  recipient's actual receipt and enforcing minimums.
- Split moves `q` from whole credit to backing and creates `q` of each claim.
  Merge does the reverse after debiting and burning both claim quantities.
- Redemption burns the requested claims and converts at most their weighted
  value from backing to whole credit. Losing claims can burn for zero. Partial
  redemption never reuses burned balances; externally held claims must first be
  deposited to receive redeemable credit.
- Whole-funded settlement moves consumed whole escrow to backing and mints both
  claims. The inactive claim returns to the funder; active proceeds plus protocol
  fees sum to the minted active quantity. Claim-funded settlement does not mint.
- Fee collection exchanges recorded protocol fees for beneficiary claim credit;
  it does not consume whole backing. Internal credit transfers preserve aggregate
  credits and reject source/destination aliases.
- Buy reservation is `ceil(remaining * bid / 1e18)`. Each fill consumes maker-price
  quote rounded down; new reserve + executed quote + released improvement equals
  old reserve. Seller exposure follows its own limit price. Final-cap failures
  roll back every prior token CPI in the transaction.
- Quote decomposition handles a conceptual 192-bit product without lossy casts.
  The independent test uses `BigUint` multiplication/division instead. Fees use
  bounded u128 products and per-order carry modulo 10,000; no floating point is
  used. Decimal precision changes display scaling, not these raw-unit equations.

## Verification and reproducibility

The review adds six Rust tests (five properties at 10,000 cases each) and six SBF
regressions, plus conservation assertions in the existing eight branch/funding
combinations, fee recovery and Token-2022 settlement tests. The original four
10,000-case properties remain. Generated cases are not exhaustive state-space
coverage; the SBF stateful sequences use a reproducible fixed seed.

| Check | Result for this review |
| --- | --- |
| SBF rebuild / SDK IDL comparison | Build passed; IDLs identical |
| Host Rust | 21 tests passed; 90,000 generated property cases in total |
| Full SBF classic + Token-2022 run | 27 passed, 9,935 assertions, no skips; includes actual scheduled fee-epoch transition |
| Fast TypeScript | 110 passed, 5,293 assertions; 31 opt-in tests/hooks skipped in this command |
| Workspace TypeScript checks | Passed |
| Strict Clippy | Passed; existing dependency future-compatibility notice remains |
| Clean host coverage | 100% pure-core lines (157/157), 94.94% core regions; token-policy lines/regions 100%; combined 23.58% (320/1,357) |

Custody and exchange have **0% host-instrumented coverage**: their CPI behavior is
exercised by the separate SBF suite, which is not included in that percentage.
No measured full-program SBF coverage or 100% contract coverage is claimed. The
web2 application E2E/browser suites were not rerun in this review; earlier results
are recorded separately in SECURITY.md.

Tested local program: `CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3`.
SBF file: `target/deploy/conditional_stocks.so`, 666,392 bytes, SHA-256
`e4e7e5ab399199dd4a268e2a296bce914943b7a7e8427a202c9d3e15f87318ec`.
This rebuild supersedes the earlier test-artifact hash, not an existing deployed
demo. The audit used a separate fresh local ledger with 64-slot epochs and
generated mock wallets, without upgrading the original UI demo or using user funds.
The validator's deployed program-data bytes matched the artifact exactly. Source,
lockfile and artifact hashes are recorded in the [review manifest](metadao-comparison-2026-09-12.json).
The temporary audit validator was stopped after the successful run; its ledger
was retained at `.local/audit-validator-hU9Vk7`. The existing demo was left alone.

```sh
anchor build -- --offline
cmp target/idl/conditional_stocks.json packages/solana-client/src/idl.json
cargo test --workspace --offline
SOLANA_TEST_RPC=http://127.0.0.1:8897 SOLANA_TEST_SHORT_EPOCHS=1 bun run test:solana
bun run test:ts
bun run typecheck
cargo clippy --workspace --all-targets --offline -- -D warnings
bun run test:coverage
cargo llvm-cov report --summary-only
```

The SBF command requires the corresponding artifact preloaded into a **fresh**
localhost validator ledger with `--slots-per-epoch 64`. Never reset an existing
user deployment to run these mock tests. Independent Solana review, runtime
hardening decisions, real-issuer review, deployment artifact/authority verification
and operational recovery rehearsal remain prerequisites for a funded release.
