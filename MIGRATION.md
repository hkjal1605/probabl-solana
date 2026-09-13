# Solana migration — work in progress

Source: `/Volumes/T9/conditional-stocks`, working tree based on
`5ab77713f1a99c1109de52cde8e037f1dbdb9499`, including uncommitted application changes.
Source files are preserved in the initial copy. Existing EVM deployment documentation,
tests, scripts and security conclusions describe the source, not a verified Solana release.

## Acceptance criteria

- Review first-party source file by file, including contracts, adversarial tests, API,
  indexer, database, planner, public UI, admin UI and operational scripts.
- Preserve the public and admin visual design and reusable application behavior.
- Replace EVM custody, signatures, addresses, transactions and indexing with Solana equivalents.
- Preserve raw-unit pricing, independent YES/NO books, whole/claim funding, GTC/IOC,
  maker-price execution, exact reservations, price improvement, per-order fee carry,
  fee caps, final-state exposure caps, nonces, recovery and manual committed resolution.
- Run Rust unit, property, adversarial account-validation and actual SVM transaction tests.
- Measure coverage and identify untested branches explicitly. Do not infer security from
  coverage or claim exhaustive edge-case coverage.
- Run TypeScript checks, application tests, builds and a local-validator browser rehearsal.

## Implemented localnet slice

- Original public UI, admin UI, assets and reusable relational/reference-data code copied. Wallet plumbing, signing, addresses, funding and transaction validation replaced with native Solana paths; the visual layout is preserved.
- Anchor Rust configuration, delayed administration, market lifecycle, six custody vaults, four native claim mints, market credits, split/merge/redemption, fees, cancellation and owner-wide nonce invalidation.
- Atomic owner-signed placement with GTC/IOC, independent YES/NO books, whole/claim funding, maker-price fills, fractional fee carry, exact reservations, self-trade/recipient aggregation, stale-plan guards and final-state caps.
- Native Hono API with origin/genesis/program/config-bound Ed25519 authentication and locally reconstructable transaction envelopes. No server trading signer.
- Manual administrative metadata/evidence preparation, immutable review, attachments, native transaction preview/simulation and finalized transaction reconciliation.
- Finalized account projection, durable transactional event replay, invocation-aware CPI rollback handling, monotonic scan checkpoints and same-bank vault reconciliation.
- Local bootstrap/dev/test runners. Credentials are generated for localhost mocks; source credentials, databases and worktrees were not retained in the application copy.

## CV-01 / CV-02 remediation — 2026-09-12

Added independent runtime claim-supply/backing and exact CPI-delta guards to both
minting paths and all position burns. Finalized reconciliation now reads claim
mint supply alongside all custody accounts in one bank snapshot per market.
INVALID redemption aggregates value and rejects fractional raw-unit burns; the
SDK/UI merge-first review retains unmatched odd claims instead of destroying them.
This changes instruction account lists and redemption economics, but not stored
account layouts. The earlier demo was not upgraded. Program and clients require
a coordinated rollout. See [the remediation record](docs/security/cv-01-02-remediation-2026-09-12.md)
for the artifact, tests, measured coverage and remaining limitations.

## MetaDAO comparative review — 2026-09-12 (historical baseline)

Retained the custom implementation and compared every first-party runtime Rust
file with MetaDAO Conditional Vault's pinned source. No upstream implementation
was copied and no production instruction, account layout or UI semantics changed.
See [the review and open concerns](docs/security/metadao-comparison-2026-09-12.md).

- Added six Rust tests, including five 10,000-case arbitrary-precision/arithmetic
  properties, and six compiled-SBF regressions for stateful conservation, external
  claims/burns, account attacks, u64 mint overflow rollback and wrapped SOL.
- Added same-snapshot assertions of total claim supply, backing, wallet credits,
  custody, fee liabilities and order exposure to the relevant validator cases.
  These assertions are test-only; production supply/backing hardening is open.
- Full compiled-SBF run: **27 passed, 9,935 assertions, no skips**, including the
  real Token-2022 fee-epoch transition. Host Rust: **21 passed**, including
  **90,000 generated property cases** across old and new properties.
- Fast TypeScript: **110 passed, 5,293 assertions**, 31 opt-in tests/hooks skipped
  in that command. Workspace typechecks and strict Clippy passed.
- Clean host coverage remains **23.58% overall**; pure-core lines and token-policy
  lines are 100%. This is not 100% smart-contract coverage.
- Rebuilt artifact SHA-256:
  `e4e7e5ab399199dd4a268e2a296bce914943b7a7e8427a202c9d3e15f87318ec`
  (666,392 bytes); isolated validator bytes and SDK/generated IDLs matched.
  The existing demo was not upgraded. Application/browser E2E was not rerun here.

No demonstrated unbacked mint, double redemption, unauthorized withdrawal or
arithmetic wraparound was identified. This is not a bug-free guarantee. INVALID
rounding can strand raw-unit value; runtime supply invariants, issuer restrictions,
independent review and production authority/recovery policies remain release gates.

## Token-2022 follow-up — 2026-09-12

Implemented dual classic-SPL/Token-2022 underlying custody, explicit extension
admission, net spendable deposit accounting, gross withdrawal debits and signed
minimum receipts. SDK/API/admin setup, program-specific ATAs, wallet transfers,
revocation, funding, UI fee review and indexer balance/reconciliation paths were
updated together. Existing exact-receipt instructions remain compatible with
classic clients. Market/config storage layout and classic outcome claim mints are
unchanged. See [the compatibility matrix](docs/TOKEN_COMPATIBILITY.md).

**All issuers/all assets are not supported.** Restricted, confidential, scaled,
hooked, permanent-delegate, pausable and unknown mint configurations fail closed.
No production issuer has been approved or integrated. Issuer-specific restrictions
must be enforced across internal claims/credits as well as external transfers;
accepting an SPL interface alone is insufficient.

| Follow-up verification | Result |
| --- | --- |
| Fast TypeScript suite | 110 passed, 5,293 assertions; 25 opt-in tests/hooks skipped in this command |
| Existing classic-SPL SBF suite against updated program | 13 passed, 217 assertions |
| Complete Token-2022 SBF suite | 8 passed, 90 assertions, including an actual scheduled epoch fee increase |
| Final SDK-boundary/raw malicious-instruction regression | Passed separately after adding client-side amount/minimum guards |
| Fee-bearing base **and** quote application rehearsal | 2 passed, 47 assertions; API/admin/indexer, underlying/claim withdrawals, balances and durable replay |
| Host Rust | 15 tests passed, including 2 token-policy/account-data tests and 40,000 generated accounting property cases |
| TypeScript checks, strict Rust Clippy | Passed |
| Public/admin production builds | Both passed; existing visual layout retained with fee disclosures |

Tested SBF artifact: 666,392 bytes; SHA-256
`7bc17d1602fa9a7f4f5daa92e6eb90797c8c31a024b05e3b2b79270430dca5ba`.
The separate validator's deployed program bytes matched this artifact exactly.
SDK and generated IDLs matched. The original mock UI deployment was not upgraded;
use a fresh local deployment with the new artifact for Token-2022. The temporary
Token-2022 test validator was stopped after verification; its ledger and generated
mock fixtures were retained. Disposable application-test databases were removed.

Clean host coverage, with token-policy tests kept outside production source:

| Source | Line coverage |
| --- | --- |
| Pure accounting | 100% (157/157); regions 94.94% |
| Token admission policy | 100% (23/23); regions 100% |
| Governance | 57.92% |
| Program entrypoints | 19.00% |
| State helpers | 6.56% |
| Custody/exchange | 0% in host instrumentation; separate SBF tests exercise these |
| Combined host report | **23.58% (320/1,357)** |

These percentages do not include validator execution and must not be described as
100% contract coverage. New tests initially exposed fixture/action/SDK argument and
web3 error-shape issues; those were corrected, then the complete suite passed.
No independent security review, all-issuer compatibility or production approval
is implied.

## Earlier classic-SPL verification (before Token-2022)

| Check | Result / scope |
| --- | --- |
| TypeScript workspace checks | Passed; retained EVM contract deployment scripts explicitly excluded |
| Fast TypeScript suite | 103 passed, 2,609 assertions; opt-in validator/application cases skipped in this command |
| Compiled SBF validator suite | 13 passed, 217 assertions, including both branches × four funding combinations |
| Copied Polymarket/reference service | 16 passed, 67 assertions, including real local PostgreSQL and WebSocket tests |
| Host Rust tests | 10 accounting/property tests, 2 controlled-clock governance tests, program-ID test |
| Generated property cases | Four accounting properties × 10,000 cases per run |
| Public/admin production builds | Both passed |
| Browser rehearsal | Copied market list, trading layout and order books inspected against native market addresses; no user-wallet signing performed |
| HTTP/native administrative E2E | Self-contained fresh-fixture run passed: 2 tests, 40 assertions; temporary DB removed after shutdown |

The final rebuilt SBF artifact was loaded on a separate localhost validator, read back byte-for-byte, and tested again: all 13 validator tests and both fresh-fixture application tests passed. Artifact size: 636,824 bytes. SHA-256: `6a64c44b0c7922fe1ee53ba3db07f7e2359d2a8e79d84c6230463d6df7eb4e8c`. Generated IDL matched the checked-in SDK IDL. `bun run check` and strict Rust Clippy passed. The running mock demo's API readiness and all 24 initialized vaults reconciled successfully.

The browser skill was used for public/admin UI checks. It exposed stale EVM/Safe operator wording, which was updated without changing the copied layout. Browser-wallet signing itself remains untested.

Clean host coverage after instrumentation cleanup:

| Rust source | Line coverage |
| --- | --- |
| Pure accounting crate | 100% (157/157); functions 100%, regions 94.94% |
| Governance handlers | 58.79% |
| Program entrypoints | 22.62% |
| State helpers | 6.56% |
| Custody / exchange handlers | 0% in the host report; exercised separately on actual SBF |
| Combined host report | **23.19% (297/1,281)** |

Anchor 1.1's CPI implementation cannot execute in the native host harness. Its no-CPI governance harness preloads valid-shaped accounts and controls Clock; native initialization and token interactions are tested separately on the validator. These are different forms of evidence, not additive coverage percentages. **100% smart-contract coverage is not achieved.**

One expanded validator run initially timed out because its deliberately unsigned transfer was dropped before execution; the test now supplies an attacker-signed instruction with the wrong source authority. The corrected isolated case and complete 13-test suite both passed.

The local validator later pruned the demo's initialization. A fresh history replay correctly failed rather than silently skipping earlier events. The running indexer's persisted checkpoint remained usable. Full rebuild after RPC retention loss requires an archival source or a verified backup. The new application runner creates a fresh protocol/database so this rehearsal does not rely on an aging demo ledger or consume UI liquidity.

## Work still required

- **Finish the requested end-to-end, file-by-file source review.** Core contract/application paths have been read, but not every contract test, UI file, generated binding, deployment script and historical artifact. The generated [source checklist](docs/migration/source-inventory.json) is an inventory, not an audit certificate; earlier unrecorded reads remain conservatively unmarked.
- Reach and measure complete native program/account-validation coverage; add broader randomized stateful SVM sequences, malicious CPI wrappers, multi-maker limits, replay/account substitution and operational failure tests. Independent Solana review remains essential.
- Complete source-style atomic stale-order cleanup, best-effort batch recovery and larger maker sweeps. Current native maximum is eight makers, with a smaller practical packet limit in some plans; address lookup tables are not implemented.
- Close UI/SDK and operational parity gaps: multi-wallet/wallet-standard support, program/PDA multisig rehearsal, production stock-token integration, historical pagination, network/deployment configuration and legacy scripts. Do not treat copied EVM tests as native coverage.
- Confirm the intentionally different native custody UX: exact pre-funding is separate; all settlement outputs are reusable market credits requiring explicit external withdrawal. This is not the source's immediate external payout with fallback.
- Review recipient recoverability, issuer freeze controls, INVALID raw-unit dust, single-key operational role policy and production upgrade-authority policy.
- Rehearse real external Polymarket sources and reviewed production mappings. Local tests use deterministic source fixtures; display-only external data never automatically resolves a market.
- Validate persistent database migrations/backups, archive-RPC recovery, service rate limits/private boundaries, attachment hosting, deployment configuration, dependency advisories and full CI SBF/application automation. Host CI is not a release approval.

No existing audit result applies to the new Rust code. No production deployment, audit approval or guarantee of zero exploitable defects follows from these results.
