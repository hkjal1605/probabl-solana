# Devnet deployment — 2026-09-13

Status: deployed and independently verified at **finalized** commitment. This is
the native Solana development deployment, not a production approval or a complete
API/indexer/UI trading rehearsal.

## Program and authorities

| Item | Value |
| --- | --- |
| Network | Solana Devnet |
| Genesis | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program | `CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3` |
| ProgramData | `Gq4DURDZKWRzSpo3V9kVHPUk49JeoirUtG8ZB9cbGqRx` |
| Configuration | `A7t71Mf3PbBuvD8jKXCYQxd9oxrf2woLf3kWszT14mxe` |
| Deployer / upgrade authority | `4o2JYy6ktdZEfaUVHGwdCbvMyypZ1NRCDpyS1rfY9q8z` |
| Deployment slot | `497447461` |
| Executable size | 690,840 bytes |
| Executable SHA-256 | `1b8b3fa1ce785b47618eb712b88613ca472fa21db6ec9f6a399db63e182540e1` |

[Program explorer](https://explorer.solana.com/address/CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3?cluster=devnet)
and [finalized deployment transaction](https://explorer.solana.com/tx/4gez2BHxhaxyrKuDHdYAM1ZqPFoWE9iGZnPjoSnTMe6o6gLtctrHVG1pLtWRTjrrZBfsar1yj3kJC7yydjAvaX1v?cluster=devnet).

The one Rust program contains custody, conditional share split/merge/redemption,
exchange and governance instructions. Configuration is initialized with mock
USDC as quote mint, zero maker/taker protocol fees, and the deployer as admin,
market admin, guardian and resolution admin. The upgrade authority remains the
deployer; it was not revoked or transferred. These concentrated authorities are
for Devnet only.

## Verified wallet allocations

All balances below were verified in associated token accounts owned by the
deployer, not deposited into protocol custody.

| Mock asset | Standard | Balance | Mint address |
| --- | --- | ---: | --- |
| USDC | Classic SPL | 1,000,000 | `iTUCuHTUHKqWe3XhUc5J3dSjmDdNuQKYtQh8KDYZdDD` |
| BTC | Classic SPL | 1,000 | `DhC4rpPyVJRHJmNqhMXchqET2o87b6JV6ebfkqA5Ufv4` |
| ETH | Classic SPL | 10,000 | `H2RuZ1p2KBtKesz6kcnLvXhtVK74LAbTrWbH5phyeMkY` |
| Wrapped Devnet SOL | Classic SPL native | 0.1 | `So11111111111111111111111111111111111111112` |
| TSLA | Token-2022 | 10,000 | `DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC` |
| NVDA | Token-2022 with transfer fee | 10,000 | `8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u` |
| SPY | Token-2022 | 10,000 | `8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3` |

The deployer also had **6.3613684 native Devnet SOL** remaining at the final
receipt check, separate from the 0.1 wrapped SOL. The difference from the 10 SOL
funded balance includes rent, transaction fees and wrapped SOL, not just fees.
The temporary upload buffer was reused rather than abandoned/recreated.

TSLA/NVDA/SPY have Token-2022 metadata with explicit Devnet mock names. NVDA has a
25 bps transfer fee capped at one token. No mock mint has a freeze authority;
the deployer controls mint/metadata authorities. Classic mock tokens do not have
Metaplex metadata and may appear by address in wallets. These assets do not
represent real USDC, BTC, ETH, issuer-backed stock rights or RWAs.

## Local records and next steps

Ignored `.local/devnet/deployment.json` contains the full public record, current
balances, ATAs and artifact/source hashes. `.local/devnet/journal.json` retains
receipts, including upload/recovery history. Preserve this directory and the
program signer securely; do not publish its private mint/buffer key files.

Generated `.local/devnet/backend.env` and `.local/devnet/ui.env` contain matching
program/config/genesis settings. Both were checked to be 0600 and contain no
deployer private key. Keep any private RPC provider credentials server-side.

**Not performed:** EC2 deployment, PostgreSQL/evidence provisioning, market
listing, protocol liquidity deposits, or Devnet end-to-end UI trading. Market
terms/conditions and offchain evidence still need review before listing. The UI
source/design was not changed. Follow the [Devnet runbook](solana-devnet.md) for
service handoff and safe reruns.

## Verification and recovery notes

- Contract rebuild matched the previously rehearsed executable byte-for-byte.
- Deployment receipt finalized successfully; on-chain executable, loader,
  upgrade authority, config, token standards, authorities, metadata and all
  allocations were read back and checked.
- Public RPC limits interrupted the bulk upload and a later read-back. The
  existing buffer was retained, finalized bytes checked, and the same deployment
  resumed without changing program or mint addresses.
- The funding check was corrected to reuse authorized buffer rent, matching the
  loader's drain-before-ProgramData behavior. Separate program-account rent,
  fixture funding and a fee reserve remain required.
- Added selectable TPU/QUIC and paced RPC upload paths, with no skipped preflight,
  feature verification, network guard or final executable verification.
- Current host suite: **151 TypeScript tests passed** (42 validator/application
  tests/hooks skipped in the host command), **25 Rust tests passed**, and one
  SBF-only Rust test ignored. Workspace typechecking passed.
- The new paced buffer path also passed an actual fresh-local-validator test:
  exact writes, preserved authority, zero-byte regions, and a no-fee no-op rerun.
  Earlier full local deployment rehearsal remains documented in the runbook.

This does not establish 100% contract coverage, universal Token-2022 issuer
compatibility, or an exploit-free implementation.
