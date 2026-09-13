# Milestone 14 — Operations, security, and testnet readiness

## Goal

Turn the feature-complete system into an observable, reproducible, incident-ready, externally reviewed v1 release candidate and prove it through sustained testnet operation.

## Dependencies

- Milestones 03–13 feature complete and integrated.

## Threat model and security review

Cover at minimum:

- collateral theft, double reservation, overfill, rounding loss, and under-collateralization;
- malicious ERC-20/ERC-1155 callbacks and token behavior;
- signature replay, nonce races, wrong-domain signatures, and compromised relayer;
- matcher censorship/reordering and double leader;
- indexer inconsistency, reorgs, and database corruption;
- compromised market-admin, guardian, or resolution-admin keys;
- wrong Polymarket mapping or manually submitted outcome;
- frontend supply-chain, RPC, paymaster, and DNS compromise;
- denial of service through orders, batches, releases, or callbacks.

No administrator may seize registered collateral, change open-market terms, or change a finalized payout.

## Observability

Build dashboards and alerts for:

- chain/RPC latency, block lag, sequencer status, reorgs, and finality;
- pending/reverted/replaced settlement transactions;
- indexer lag, replay/checkpoint hashes, and projection divergence;
- matcher queue lag, leader lease, batch age, and shadow divergence;
- per-book spread, depth, two-sided uptime, stale time, and maker concentration;
- Polymarket feed age, disconnects, and snapshot divergence;
- exchange/CTF collateral reconciliation and reservation mismatches;
- Stock Token oracle, pause, and multiplier changes;
- markets awaiting manual resolution, evidence-review status, and admin multisig health;
- wallet/paymaster failure and user-paid fallback rate.

There are no KYC or compliance-provider health monitors in v1.

## Runbooks

Write and rehearse:

- Robinhood Chain outage/reorg;
- matcher outage/double leader/divergence;
- relayer or paymaster failure/compromise;
- indexer lag/corruption/full rebuild;
- stale or corrupt Polymarket data;
- disputed/delayed outcome and conflicting manual evidence;
- wrong mapping or incorrect manual resolution submission;
- Stock Token pause or corporate action;
- stablecoin issue;
- contract vulnerability and scoped pause;
- admin/guardian/resolution key rotation or compromise;
- frontend/API outage while direct cancellation/redemption remains available.

## Testnet endurance and chaos

- Run a minimum two-week internal test with representative liquidity and continuous reconciliation.
- Execute YES, NO, invalid, disputed, and delayed resolution scenarios manually.
- Inject RPC disagreement, dropped WebSocket frames, reorgs, service restarts, stuck transactions, leader loss, corrupted checkpoints, and paymaster failures.
- Freeze a market with thousands of open orders and release reservations in bounded calls.
- Run economic simulations for sparse/adversarial books, probability jumps, stock gaps, latency, and liquidity withdrawal.

## Audit and release engineering

- Freeze v1 interfaces and contract scope before external audit.
- Complete static analysis, property tests, high-run fuzzing, gas analysis, and reproducible builds.
- Obtain at least two independent contract audits, including an accounting/economic focus, and close findings with regression tests.
- Conduct manual-resolution and admin-key tabletop exercises.
- Establish bug-bounty scope and disclosure channel.
- Verify deployment bytecode/source and record compiler/settings/manifests.
- Conduct multisig key ceremonies and least-privilege role assignment.

## Deliverables

- Threat model and security assumptions.
- Monitoring dashboards, SLOs, and paging policies.
- Reconciliation and incident runbooks.
- Chaos/endurance/economic simulation reports.
- Audit reports, finding tracker, and regression tests.
- Reproducible release candidate and deployment manifests.
- Pilot readiness review packet.

## Exit criteria

- [ ] Two-week testnet run completes with no unexplained reconciliation difference.
- [ ] All manual resolution outcomes and delay/dispute cases are exercised.
- [ ] Critical runbooks are rehearsed and timed.
- [ ] No unresolved critical/high audit finding remains.
- [ ] Contract source/bytecode/builds are reproducible and verified.
- [ ] Admin, matcher, guardian, and resolution permissions are least privilege.
- [ ] Security, issuer compatibility, data rights, and operations approve the defined v1 release candidate.
- [ ] KYC and related access controls remain absent and documented as post-v1 work.

## Non-goals

- Adding late features during audit remediation.
- KYC/compliance integration.
- Cross-chain resolution automation.
- Scaling beyond the capped pilot profile.

