# Solana token and issuer compatibility

This is an unaudited, development-only compatibility policy, not a certification
for any real issuer. The runtime is issuer-agnostic **within the supported token
behaviors below**. There is no hard-coded issuer, ticker or mint allowlist. Pool
creation (including issuer-control admission) and market listing require the
configured market administrator.

Supporting every crypto asset, stock and RWA from every issuer is **not achieved**.
Issuer controls are admitted only per pool, explicitly and exactly, and their live
state (pause, UI multiplier, vault freeze, hook program) is re-checked on every
custody and exposure path. Controls that are fundamentally incompatible with
unrestricted custodial claims without an issuer-specific integration stay rejected.
Silently bypassing an issuer's restrictions is not compatibility.

## Admission tiers

Every custody pool (`pool = ["pool", config, mint]`) is created by the market
administrator with `initialize_pool(admitted)`. Two tiers exist:

- **Generic tier** (`admitted = 0`): extensions that never grant anyone authority
  over custody. Required for the deployment quote and for every protocol claim mint.
- **Issuer tier** (`admitted != 0`): a listing decision that explicitly admits the
  issuer-control categories used by a regulated tokenized-stock issuer. `admitted`
  must equal the mint's issuer-control categories **exactly** (an unused grant is
  rejected, because it would silently widen what a later issuer reconfiguration could
  introduce). The SDK computes the mask with `mintAdmission` from `/admin`.

A market lists one quote and up to three base legs, one whitelisted issuer token of
the same stock per leg (see [multi-issuer-markets.md](multi-issuer-markets.md)).
Each leg's claims are backed only by that issuer's pool.

## Admission matrix

| Mint / extension | Tier | Current treatment |
| --- | --- | --- |
| Classic SPL fungible mint | generic | Accepted; raw-unit accounting |
| Token-2022 without mint extensions | generic | Accepted, including mixed classic/Token-2022 legs and quote |
| TransferFeeConfig | generic | Accepted; net spendable deposits, gross credit debits on withdrawal, signed minimum receipts |
| MetadataPointer, TokenMetadata | generic | Accepted; metadata never grants custody authority or proves issuer identity |
| GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember | generic | Accepted; grouping is descriptive, not a claim of issuer authorization or eligibility enforcement |
| PermanentDelegate | issuer, bit `1` | Admitted only with bit 1. A trust decision in that issuer: a seizure from the pool vault makes **that** pool fail its solvency checks (isolated per mint); other mints and legs are unaffected |
| Pausable | issuer, bit `2` | Admitted only with bit 2. While paused: pool deposits/withdrawals fail with `IssuerPaused`; new exposure on that leg (fills, resting asks, split) fails with `LegHalted`. Other legs of the same book keep trading. Merge/redeem of existing claims stays available |
| DefaultAccountState | issuer, bit `4` | Admitted only with bit 4. A pool vault that starts (or is later) frozen cannot be listed (`add_base`) or traded (`LegHalted`) until the issuer thaws it. Securitize/Superstate-style default-frozen mints need issuer allowlisting and a thaw first |
| ScaledUiAmount | issuer, bit `8` | Admitted only with bit 8. The book trades share units; every fill converts to raw issuer units at the live multiplier (`new_multiplier` once its timestamp passes). New exposure requires `4/5 <= live / listing <= 5/4` (dividend band); a split or reverse split leaves the band and halts the leg (`LegHalted`) |
| TransferHook | issuer, bit `16` | Admitted only with bit 16 **and** while the hook `program_id` is unset. No hook CPI is ever performed. Setting a hook program makes every custody and exposure path fail with `TransferHookEnabled` |
| ConfidentialTransferMint | issuer, bit `32` | Admitted only with bit 32, as mint-level configuration. Protocol vaults never enable confidential balances, so custody stays public and exact |
| NonTransferable | — | Rejected; incompatible with freely transferable trading claims |
| ConfidentialTransferFeeConfig, ConfidentialMintBurn | — | Rejected; this public order book has no confidential custody/proof integration |
| InterestBearingConfig | — | Rejected until display, pricing, quantity and redemption semantics are explicitly integrated |
| MintCloseAuthority | — | Rejected; avoid a close/reinitialize identity lifecycle for admitted collateral |
| Unknown, future or account-only extension used on a mint | — | Rejected; new extensions require an explicit reviewed policy change |

Mainnet issuer configurations the tier was built against (read 2026-09-23; raw
account bytes in `packages/solana-client/test/fixtures/`):

| Issuer | Example | Decimals | Extensions | `admitted` |
| --- | --- | --- | --- | --- |
| xStocks | NVDAx | 8 | MetadataPointer, PermanentDelegate, DefaultAccountState (initialized), ScaledUiAmount (≈1.0017, scheduled updates), Pausable, ConfidentialTransferMint (no auto-approve), TransferHook (unset), TokenMetadata | 63 |
| Ondo Global Markets | NVDAon | 9 | as xStocks without PermanentDelegate | 62 |
| Remora | NVDAr | 9 | as xStocks without TransferHook | 47 |
| Backpack Securities | SPCX | 6 | all six issuer controls | 63 |

Local and Devnet fixtures (`scripts/solana/mock-issuers.ts`) replicate these
configurations with the real Token-2022 instructions, in the mainnet extension order,
with a local mock authority standing in for the issuer (pause, multiplier update,
freeze). They are test doubles, never real issuer tokens.

The Rust program enforces this policy at configuration initialization, pool creation
(`initialize_pool`), market creation (quote), leg listing (`add_base`), every pool
deposit/withdrawal and every exposure path (`place` re-reads each touched leg's mint
and pool vault; `split` re-reads its leg). Its `InterfaceAccount` constraints bind
each mint, source/destination and vault to the supplied **canonical** token program.
The SDK applies the same policy (`decodeSupportedMint(address, info, admitted)`,
`issuerState`, `liveLegs`) before funding, transfers, pool setup, planning and
withdrawals; `liveLegs` reports why a leg is halted (`issuer-paused`,
`vault-frozen`, `corporate-action`, `transfer-hook`, `delisted`, ...).

Mint and freeze authorities remain issuer risks on both token programs. A permitted
freeze authority can halt deposits and withdrawals; the protocol cannot thaw an
issuer's token. Fully collateralized but frozen vaults fail readiness reconciliation.
Internal claims/credits do not inherit that issuer's freeze or beneficial-owner
eligibility policy. **Do not list a restricted RWA merely because its mint passes
the technical extension check.** No real issuer is approved by these tests.

The protocol-created outcome claim mints (YES/NO per listed collateral) remain
classic SPL tokens. They are claims on net pool collateral of **one** issuer, not
issuer-created stock tokens. They do not inherit issuer metadata, hooks, pause,
freeze controls, UI multipliers or transfer fees. Matching, split, merge and
redemption move internal credits/backing and classic claims; issuer transfer fees
apply when the underlying token actually enters or leaves custody.

Native SOL requires an SPL wrapped-SOL account; the UI does not automatically wrap
or unwrap SOL. Arbitrary custom token programs, compressed assets/NFTs and offchain
stock/RWA ownership rights are not covered by this fungible-token implementation.

## Transfer fees and signed review

Underlying tokens (quote and every issuer leg) enter custody only through the
protocol-wide pool: `deposit_pool(amount, minimum_credit)` transfers a fixed gross
`amount`, reloads the pool vault and credits the owner's `AssetCredit` with only its
increase in spendable `amount`. The Token-2022 withheld-fee extension is never
counted as backing or credit. The transaction fails atomically if the increase is
below the signed positive minimum. The event reports credited net units. Issuer fee
harvesting does not consume that backing.

`withdraw_pool(amount, minimum_received)` debits exactly the gross amount from the
owner's available credit. It verifies that the pool vault lost exactly that amount
and the recipient gained at least the signed positive minimum. Withdraw events report
the gross credit debit. A withdrawal consuming everything as fees is rejected.
Claim tokens (always classic SPL, no fees) use the per-market `deposit`/`withdraw`
(and `_bounded`) instructions.

Exact-receipt variants (`deposit`/`withdraw`, or a minimum equal to the amount)
use the full amount as their minimum, so nonzero transfer fees cause rollback. Existing
classic clients do not silently accept fees. The SDK's `depositForCredit` computes
the smallest u64 gross amount supplying the requested net credit with integer-only
arithmetic. `withdrawCredit` quotes the current epoch's net receipt. Fee or epoch
changes causing a worse receipt invalidate the old signature instead of losing
unreviewed tokens. A lower fee may credit more than the minimum on deposit.

Wallet transfer instructions use Token-2022's explicit expected-fee instruction.
Funding review displays the gross amount and issuer fee. Withdrawal, wallet transfer
and split funding show a fee confirmation when applicable. Locally reconstructed
instruction bytes, not API-provided fee labels, determine the signed limits. Issuer
fees are separate from the exchange's maker/taker fee caps. An issuer can set fees
that make recovery economically unattractive; the minimum receipt prevents surprise
execution but does not guarantee future low-cost liquidity.

Token-program-specific ATAs are used by the SDK, admin initialization and indexer.
Wrong-program addresses are not interchangeable. Recipient memo requirements and
source CPI guards are respected by the token program: incompatible operations fail
and roll back. The application does not automatically disable user protections or
approve a delegate to evade them. Automatic memo insertion is not implemented.

## Issuer integration release gates

For a restricted issuer, first review the actual mint, extension configuration,
authorities, hooks, issuer terms and supported cluster—not its ticker or logo.
Agree how custody, beneficial ownership, secondary claim transfers, eligibility,
freeze, seizure, forced redemption and issuer policy changes apply. An adapter must
enforce the agreed policy on **every** relevant path: external custody, wallet credit
transfer, order matching, claim transfers, split/merge, fee recovery and redemption.

Arbitrary hook execution (a configured `TransferHook` program) additionally needs
reviewed extra-account resolution, program/account allowlists, CPI privilege/aliasing
checks and malicious-hook tests; until then a configured hook halts custody.
Admitting PermanentDelegate is a trust decision, not a recovery policy: passing a
token balance check cannot prevent an issuer seizure later, it only confines the
resulting insolvency to that issuer's pool. None of those adapters or approvals are
supplied by this baseline.

## Reproducible checks

Use a fresh local validator ledger and the compiled program. For the scheduled fee
change test, launch it with `--slots-per-epoch 64`; that option has no effect on an
existing ledger. Do not reset an existing deployment to enable it.

```sh
bun run build:contracts
SOLANA_TEST_RPC=http://127.0.0.1:8897 SOLANA_TEST_SHORT_EPOCHS=1 bun run test:solana
SOLANA_POOL_TEST_RPC=http://127.0.0.1:8897 bun run test:pools
SOLANA_TEST_RPC=http://127.0.0.1:8897 SOLANA_TEST_TOKEN_2022=1 \
  TEST_DATABASE_URL=postgresql://LOCAL_TEST_USER@127.0.0.1:LOCAL_TEST_PORT/postgres \
  bun run test:application
```

`test:solana` runs the core, Token-2022 and multi-issuer validator suites. Without
`SOLANA_TEST_SHORT_EPOCHS=1`, only the actual scheduled-epoch transition case is
skipped; fee math and the other Token-2022 cases still run. The application runner
creates a fresh disposable database and mock token deployment, then removes only
that test database after stopping its test services. The bootstrap always lists
issuer replicas as base legs; `SOLANA_TEST_TOKEN_2022=1` additionally makes the quote
a fee-bearing Token-2022 mint and lists a plain fee-bearing Token-2022 base leg
(Token-2022 rejects a transfer fee next to the issuers' ConfidentialTransferMint, so
the replicas themselves never carry one).

Tests exercise real Token-2022 CPIs on SBF: exact pool admission (and rejection of a
wrong mask), deposits/withdrawals of issuer tokens with every issuer extension,
three legs with different decimals, one bid filled by asks of two issuers with
live-multiplier conversion and surplus refunds, issuer pause, in-band and
out-of-band multiplier updates, delisting with public cancellation, per-leg
split/merge/redeem, mixed programs, net/withheld accounting, harvest,
minimum-receipt rollback, wrong program, issuer freeze/thaw, scheduled fee changes,
direct transfer/revocation and account CPI/memo restrictions. Host tests
(`issuer_policy`) run the policy against the real mainnet mint bytes. SDK tests cover
TLV framing, issuer state decoding, multiplier math shared with Rust, epoch
selection, u64 limits, capped/100% fees and minimal gross-up. These do not
constitute exhaustive coverage or an independent audit.

## Primary implementation references

- [Anchor token-interface CPI and constraints](https://www.anchor-lang.com/docs/tokens/basics/transfer-tokens)
- [Token-2022 extension semantics](https://www.solana-program.com/docs/token-2022/extensions)
- [Issuer transfer-hook interface](https://www.solana-program.com/docs/transfer-hook-interface)

Implementation was checked against the pinned local Anchor SPL 1.1.2 and SPL Token
JS 0.4.14 source as well as these documents. Future token extensions remain unsupported
until reviewed, even if a newer client library recognizes their numeric identifiers.
