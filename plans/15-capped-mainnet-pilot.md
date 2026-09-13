# Milestone 15 — Capped mainnet pilot

## Goal

Launch and operate v1 with contract-enforced order and live open-order notional caps plus separately monitored exposure limits; complete at least three full market cycles without custody discrepancies or incorrect payouts. Production remains blocked until audit M-02 receives independent cryptographic clearance.

## Dependencies

- Milestone 14 release candidate, audits, runbooks, and approvals.

## Pilot scope

- Approximately three supported, liquid Stock Tokens.
- Three to five unambiguous scheduled binary Polymarket events.
- USDG as the only quote token.
- Zero protocol trading fees.
- GTC limits and protected IOC only.
- Sponsored gas with documented user-paid fallback.
- Small initial participant cohort without KYC, geography, investor-status, or appropriateness gating.
- Per-wallet and market live open-order notional caps; wallet caps are not Sybil-resistant. Filled exposure and total CTF issuance are excluded. A pilot requiring hard exposure caps must obtain a separately reviewed architecture change before launch.
- Manual admin-only market creation and manual admin-only resolution.
- Operational coverage around every cutoff and resolution.

## Pre-deployment checklist

- Verify current chain ID, RPC, explorer, token, oracle, paymaster, and wallet configuration from authoritative sources.
- Deploy non-upgradeable contracts from the audited commit using reproducible settings.
- Verify source and bytecode and publish deployment manifests.
- Assign market-admin, matcher, guardian, resolution-admin, and treasury roles to approved addresses/multisigs.
- Test pause, cancel, release, merge, and redeem with production configuration and small amounts.
- Confirm monitoring, paging, reconciliation, backups, evidence storage, status communication, and incident ownership.
- Confirm selected Stock Tokens and events avoid known corporate actions and ambiguous outcomes.
- Publish market terms, manual-resolution trust disclosure, smart-contract/chain/liquidity risks, and direct recovery instructions.

## Per-market launch process

1. Prepare and independently review the exact stock/event mapping and terms.
2. Manually create the market through the admin multisig.
3. Verify emitted immutable terms against the approved artifact.
4. Seed or confirm independent two-sided liquidity before presenting a reliable conditional estimate.
5. Monitor open trading, caps, book quality, collateral, and settlement queues.
6. Freeze at the configured cutoff or earlier incident/outcome-knowledge boundary.
7. Release all unfilled reservations and archive the pre-resolution signal.
8. Manually prepare/review Polymarket resolution evidence.
9. Manually resolve through the resolution-admin multisig.
10. Reconcile payout and evidence, verify redemption, and publish the result.

## Rollout controls

- Begin with the smallest market-wide caps and raise them only after a reconciled completed cycle and explicit approval.
- Do not raise caps while an accounting, oracle, multiplier, mapping, matcher, or resolution issue is unresolved.
- A probability-feed outage alone marks data stale; it must not trap collateral.
- Guardian may stop new trading/fills but cannot block user recovery.
- There is no in-place contract upgrade. A contract defect stops new v1 markets and is fixed in a separately deployed version while old positions remain recoverable.

## Success measures

- Two-sided quote uptime on both branches.
- Executable spread and standard-size depth.
- Fill rate and time to fill.
- Number and concentration of liquidity providers.
- Reliable conditional-price snapshot at freeze.
- Manual resolution latency after final Polymarket outcome.
- Zero incorrect local payouts.
- Zero unexplained collateral or reservation discrepancy.
- Merge/redemption success and direct recovery availability.
- Service, RPC, and sponsored-gas reliability.

Raw trading volume is diagnostic, not the primary success metric.

## Incident policy

- Freeze affected new trading immediately when an invariant or mapping is in doubt.
- Preserve cancellation, release, merge, and redemption.
- Record every operator action and relevant reason/evidence hash.
- Publish a postmortem for material incidents.
- Never repair an accounting mismatch by editing PostgreSQL balances.
- Never change an immutable mapping or finalized payout.

## Deliverables

- Production deployment manifests and verified source links.
- Approved market terms and evidence records for every pilot market.
- Daily reconciliation and book-quality reports.
- Resolution and redemption reports.
- Incident/postmortem records where applicable.
- End-of-pilot review with an explicit stop/continue decision.

## Exit criteria

- [ ] At least three markets complete creation, trading, freeze, manual resolution, and redemption.
- [ ] Every payout matches the reviewed final Polymarket outcome.
- [ ] No custody or reservation discrepancy remains unexplained.
- [ ] Conditional prices meet the documented minimum reliability standard often enough to justify the product.
- [ ] Cancellation, merge, and redemption remain usable during service or market incidents.
- [ ] Any cap increase or post-v1 feature proposal is backed by pilot evidence.
- [ ] Deferred KYC/access-control and any automated-resolution proposals remain separate later-version decisions.

## Non-goals

- Broad uncapped launch.
- New assets/order types/fees during the pilot.
- KYC or identity-based restrictions.
- Automated or cross-chain resolution.
- Silent changes to the two-CLOB market structure.
