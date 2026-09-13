# Solana token and issuer compatibility

This is an unaudited, development-only compatibility policy, not a certification
for any real issuer. The runtime is issuer-agnostic **within the supported token
behaviors below**. There is no hard-coded issuer, ticker or mint allowlist. Market
listing still requires the configured market administrator.

Supporting every crypto asset, stock and RWA from every issuer is **not achieved**.
Some issuer controls are fundamentally incompatible with unrestricted custodial
claims without an issuer-specific integration. Rejecting those mints is intentional;
silently bypassing their restrictions is not compatibility.

## Admission matrix

| Mint / extension | Current treatment |
| --- | --- |
| Classic SPL fungible mint | Accepted; raw-unit accounting |
| Token-2022 without mint extensions | Accepted, including mixed classic/Token-2022 base and quote |
| TransferFeeConfig | Accepted; net spendable deposits, gross credit debits on withdrawal, signed minimum receipts |
| MetadataPointer, TokenMetadata | Accepted; metadata never grants custody authority or proves issuer identity |
| GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember | Accepted; grouping is descriptive, not a claim of issuer authorization or eligibility enforcement |
| PermanentDelegate | Rejected, even with a currently empty delegate; a delegate can move/burn vault collateral outside protocol accounting |
| TransferHook | Rejected, even with a currently disabled hook; no arbitrary hook CPI or remaining-account forwarding |
| NonTransferable | Rejected; incompatible with freely transferable trading claims |
| DefaultAccountState | Rejected; frozen-account onboarding needs issuer coordination |
| ConfidentialTransferMint, ConfidentialTransferFeeConfig, ConfidentialMintBurn | Rejected; this public order book has no confidential custody/proof integration |
| InterestBearingConfig, ScaledUiAmount | Rejected until display, pricing, quantity and redemption semantics are explicitly integrated; a decimals-only UI would be misleading |
| Pausable | Rejected pending an issuer-pause integration across internal credit trading and external custody |
| MintCloseAuthority | Rejected; avoid a close/reinitialize identity lifecycle for admitted collateral |
| Unknown, future or account-only extension used on a mint | Rejected; new extensions require an explicit reviewed policy change |

The Rust program enforces this policy at configuration initialization, market
creation, underlying vault initialization and every deposit/withdrawal. Its
`InterfaceAccount` constraints bind each mint, source/destination and vault to the
supplied **canonical** token program. The SDK applies the same extension allowlist
before funding, transfers, vault setup and withdrawals.

Mint and freeze authorities remain issuer risks on both token programs. A permitted
freeze authority can halt deposits and withdrawals; the protocol cannot thaw an
issuer's token. Fully collateralized but frozen vaults fail readiness reconciliation.
Internal claims/credits do not inherit that issuer's freeze or beneficial-owner
eligibility policy. **Do not list a restricted RWA merely because its mint passes
the technical extension check.** No real issuer is approved by these tests.

The four protocol-created outcome claim mints remain classic SPL tokens. They are
claims on net vault collateral, not issuer-created stock tokens. They do not inherit
issuer metadata, hooks, freeze controls or transfer fees. Matching, split, merge and
redemption move internal credits/backing and classic claims; issuer transfer fees
apply when the underlying token actually enters or leaves custody.

Native SOL requires an SPL wrapped-SOL account; the UI does not automatically wrap
or unwrap SOL. Arbitrary custom token programs, compressed assets/NFTs and offchain
stock/RWA ownership rights are not covered by this fungible-token implementation.

## Transfer fees and signed review

`deposit_bounded(asset, amount, minimum_credit)` transfers a fixed gross `amount`,
reloads the vault and credits only its increase in spendable `amount`. The Token-2022
withheld-fee extension is never counted as backing or credit. The transaction fails
atomically if the increase is below the signed positive minimum. The deposit event
reports credited net units. Issuer fee harvesting does not consume that backing.

`withdraw_bounded(asset, amount, minimum_received)` debits exactly the gross amount
from the owner's credits. It verifies that the vault lost exactly that amount and
the recipient gained at least the signed positive minimum. Withdraw events report
the gross credit debit. A withdrawal consuming everything as fees is rejected.

The existing `deposit` and `withdraw` instructions retain exact-receipt semantics:
their minimum is the full amount, so nonzero transfer fees cause rollback. Existing
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

Arbitrary hook execution additionally needs reviewed extra-account resolution,
program/account allowlists, CPI privilege/aliasing checks and malicious-hook tests.
Permanent-delegate assets need a separately designed insolvency/recovery policy;
passing a token balance check cannot prevent an issuer seizure later. None of those
adapters or approvals are supplied by this baseline.

## Reproducible checks

Use a fresh local validator ledger and the compiled program. For the scheduled fee
change test, launch it with `--slots-per-epoch 64`; that option has no effect on an
existing ledger. Do not reset an existing deployment to enable it.

```sh
bun run build:contracts
SOLANA_TEST_RPC=http://127.0.0.1:8897 SOLANA_TEST_SHORT_EPOCHS=1 bun run test:solana
SOLANA_TEST_RPC=http://127.0.0.1:8897 SOLANA_TEST_TOKEN_2022=1 \
  TEST_DATABASE_URL=postgresql://LOCAL_TEST_USER@127.0.0.1:LOCAL_TEST_PORT/postgres \
  bun run test:application
```

Without `SOLANA_TEST_SHORT_EPOCHS=1`, only the actual scheduled-epoch transition case
is skipped; fee math and the other Token-2022 cases still run. The application runner
creates a fresh disposable database and mock token deployment, then removes only
that test database after stopping its test services. `SOLANA_TEST_TOKEN_2022=1` makes
the bootstrap's base and quote mocks fee-bearing Token-2022 mints.

Tests exercise real Token-2022 CPIs on SBF: mixed programs, net/withheld accounting,
harvest, minimum-receipt rollback, wrong program, issuer freeze/thaw, matching,
redemption, six-vault reconciliation, eight restricted mint configurations, scheduled
fee changes, direct transfer/revocation and account CPI/memo restrictions. SDK tests
cover allowlist/TLV framing, epoch selection, u64 limits, capped/100% fees and minimal
gross-up. These do not constitute exhaustive coverage or an independent audit.

## Primary implementation references

- [Anchor token-interface CPI and constraints](https://www.anchor-lang.com/docs/tokens/basics/transfer-tokens)
- [Token-2022 extension semantics](https://www.solana-program.com/docs/token-2022/extensions)
- [Issuer transfer-hook interface](https://www.solana-program.com/docs/transfer-hook-interface)

Implementation was checked against the pinned local Anchor SPL 1.1.2 and SPL Token
JS 0.4.14 source as well as these documents. Future token extensions remain unsupported
until reviewed, even if a newer client library recognizes their numeric identifiers.
