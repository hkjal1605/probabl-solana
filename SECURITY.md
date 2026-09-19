# Solana security boundary

**Unaudited Solana program. Do not deploy with real funds.** Passing tests and core arithmetic coverage do not establish that the Rust program is free from exploitable defects.

An agent-assisted [MetaDAO comparative review](docs/security/metadao-comparison-2026-09-12.md)
covers the current first-party Rust program and adds arithmetic/SBF regressions.
It is not an independent audit or a production approval. CV-01 and CV-02 were
subsequently addressed in [the remediation record](docs/security/cv-01-02-remediation-2026-09-12.md);
the other release gates remain.

## Current design

- Native transaction signers authorize placement and the reviewed maker plan. There is no EVM signature, allowance or backend settlement key in the active trading path.
- Classic SPL and an explicit Token-2022 extension subset are supported. See [the token/issuer compatibility policy](docs/TOKEN_COMPATIBILITY.md). Transfer fees use net spendable accounting and signed minimum receipts. Hooks, permanent delegates, confidential/restricted/scaled mints and unknown extensions fail closed; this is not support for every RWA issuer.
- PDA accounts bind configuration, market, wallet, trader nonce, order, mint and custody vault identities. Cross-market and owner substitutions are rejected.
- Amounts use SPL's u64 raw-unit range; prices retain a u128 ratio scaled by 1e18. Arithmetic is checked.
- Escrow reserves worst-case funding. Each fill uses the maker's price, exact reservation release and per-order fractional fee carry.
- Caps apply to final resting-order exposure, not total collateral, filled positions or Sybil-resistant risk.
- Trade proceeds and recoveries become beneficiary-owned market credits. Only the beneficiary can withdraw or transfer those credits; governance can collect earned fee credits only.
- Classic SPL and Token-2022 spendable custody are reconciled against credits, escrow, backing and protocol fees. Withheld issuer fees and unsolicited token dust are not user credit. Frozen vaults fail readiness even when collateralized.
- Split, merge, redeem and order placement independently check total claim supply (including external holders) against backing, custody against recorded liabilities, and exact post-CPI mint/burn deltas. Finalized reconciliation fetches all four claim mints in the same bank snapshot as custody and backing.
- INVALID redemption aggregates YES/NO value and accepts only exact raw-unit payouts. Recovery merges matching pairs first, redeems representable excess, and retains an unmatched odd claim instead of burning its fractional value. The UI reviews exact burns, credits and retained claims before signing.
- Cancel/recovery, withdrawal, complete-set merge and resolved redemption remain available during a protocol pause, subject to token issuer restrictions and network liveness.
- Each deployment has owner-wide monotonic nonce invalidation across markets. Order and trader accounts are not closed/reused.
- Market administration commits to a domain-separated SHA-256 resolution hash. Resolution administration must reveal the exact YES, NO or INVALID payout, evidence hash and URI. Incorrect commitments have no unilateral override.
- Finalized indexing commits events and scan checkpoints together. Events from failed nested invocations are discarded, even if the outer transaction succeeds. Missing history fails closed and may require archival RPC recovery.

## Explicit limitations and release gates

The release gaps below remain open until independently reviewed and rehearsed.

- Full source review and Solana feature parity are unfinished.
- Measured 100% line coverage is confined to the pure accounting crate and token-admission policy. Anchor custody/exchange CPI handlers are exercised on a validator but are not included in host coverage. Full program coverage has not been achieved.
- Independent Solana/account-validation review, deployment/upgrade-authority governance, artifact verification, multisig rehearsal, RPC failover, backup recovery and incident response are still required.
- A program deployed with an upgrade authority remains upgradeable regardless of its ordinary instruction permissions. Local preloaded-validator tests do not verify a production upgrade policy.
- Operational roles each identify one key; a reviewed external multisig/PDA authority would need separate integration and testing. Config administration has a fixed two-day handoff delay; ordinary role/fee configuration is immediate.
- The planner bounds maker count at eight, and the transaction packet limit may bind sooner. Address lookup tables, large-book execution and source-style atomic stale-order cleanup/batch recovery remain incomplete.
- The API chooses price/FIFO liquidity. The program validates the signed plan, limits and guards, not global best-price completeness. A stale or oversized plan must fail, not silently execute a different sweep.
- Funding is a separate reviewed gross deposit transaction with a signed minimum net credit. If subsequent placement fails, funded assets remain credits; the earlier funding transaction and any issuer transfer fee are not rolled back. Issuer withdrawal fees/freeze controls can affect later recovery.
- Claim settlement is credited, not automatically pushed to external ATAs. The UI shows credits and exposes withdrawal. Recipients must control the chosen key or a program capable of signing for it; selecting an unspendable recipient can strand the recipient's funds.
- INVALID's last unmatched raw claim cannot pay half an indivisible underlying unit by itself. It remains owned and transferable/combinable. Previously burned dust is not retroactively reassigned. Binary losing-claim burns still return zero and require an explicit UI warning.
- CV-01 adds read-only underlying vault accounts to position and placement instructions. Program, SDK/IDL and applications must be rolled out together; old transaction builders are not compatible. Account storage layouts are unchanged.
- No total-value, issuer-solvency, regulatory, bridging or stock-rights guarantee exists. Mock SPL tokens are not production stock assets. Token issuer freeze controls can prevent transfers.
- Metadata/probability is display-only. Operators can jointly approve a factually wrong outcome. There is no Polygon proof, oracle bridge or automatic resolution.
- Production authentication rate limits, private service boundaries, HTTPS attachment hosting, dependency review and operational hardening still need validation. The development database runner is not a persistence/backup deployment strategy.
- No user wallet was imported or used in the browser rehearsal. Automated signing used generated local-only test keys.

## Reporting

Keep suspected vulnerabilities private while funds could be at risk. Provide the affected program/configuration, instruction/account inputs and a minimal reproduction to the project owner's private security contact. That contact must be published before any funded release.
