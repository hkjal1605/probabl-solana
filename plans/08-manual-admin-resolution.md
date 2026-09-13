# Milestone 08 — Manual admin resolution

## Implementation status — 2026-09-04

`ManualResolutionController` implements dedicated-role authorization, awaiting-resolution enforcement, one-time finalization, bounded evidence references, and only the three approved payout vectors. The simulation-first admin CLI and manual four-eyes runbook contain no Polygon watcher, bridge, attestation, proof, or automatic trigger. Multisig rehearsal and independent audit remain launch gates.

## Goal

Implement the sole v1 settlement authority: an admin-gated, manually invoked, one-time resolution controller with a public evidence reference and no cross-chain automation.

## Dependencies

- Milestone 03 CTF oracle behavior.
- Milestone 04 immutable market mapping and lifecycle.
- Milestone 07 redemption and pause guarantees.

## Contract scope

Implement `ManualResolutionController` with:

- `RESOLUTION_ADMIN_ROLE` assigned to a dedicated multisig;
- registration of the local market, local question ID, condition ID, and immutable Polymarket reference;
- `resolveMarket(localMarketId, payoutNumerators, payoutDenominator, evidenceHash, sourceReference)`;
- market-state requirement of `AwaitingResolution`;
- allowed vectors only: YES `[1,0]/1`, NO `[0,1]/1`, invalid `[1,1]/2`;
- nonzero evidence hash and bounded/validated source-reference representation;
- one-time finalization and replay protection;
- state update before external CTF reporting;
- a complete `ResolutionFinalized` event;
- transition to resolved/redeemable state.

The controller verifies authorization, structure, state, and uniqueness. It does not and cannot verify whether the admin copied Polymarket’s factual outcome correctly.

## Manual operations workflow

1. Freeze the local market and release unfilled reservations.
2. First operator verifies the exact immutable Polymarket condition and final outcome.
3. First operator creates a resolution packet with condition ID, outcome orientation, vector, official URL/status, Polygon address/transaction/block when available, timestamp, and supporting evidence.
4. Second operator independently verifies and approves the packet.
5. Store the packet and reviews in append-only storage and calculate `evidenceHash`.
6. Submit the approved transaction through the resolution-admin multisig.
7. Reconcile the emitted vector and evidence hash with the packet.
8. Verify direct claim redemption and publish resolution status.

## Trust and key controls

- Market admin, guardian, matcher, relayer, and resolution admin are distinct roles.
- Use hardware-backed multisig keys and documented signer ownership.
- A resolution admin cannot remap a market, change a finalized payout, transfer collateral, or resolve before freeze/awaiting-resolution state.
- A compromised quorum can submit a factually wrong allowed vector; this is an explicit v1 trust assumption and must be disclosed.

## No automated resolution

Do not implement:

- Polygon RPC watcher jobs;
- EIP-712 outcome attestation committees;
- permissionless proposal/finalization;
- bridge messages, light clients, or state proofs;
- API-, price-, or news-triggered resolution;
- a fallback outcome when Polymarket never resolves.

## Edge cases

- Disputed Polymarket outcome: remain awaiting resolution.
- Invalid/unknown outcome: submit `[1,1]/2` only after final confirmation.
- Inconsistent evidence or operator disagreement: do not submit.
- Polygon reorg concern: wait for stable official evidence.
- Wrong market mapping discovered after fills: freeze, publish incident, and do not remap or invent an outcome.
- Polymarket never resolves: claims remain unresolved; no deadline shortcut.

## Tests

- Authorized YES, NO, and invalid resolution.
- Unauthorized caller, wrong role, wrong market state, empty evidence, malformed vector, zero denominator, and second resolution rejection.
- Resolution during all pause variants while ensuring redemption remains available afterward.
- Reentrancy and state-before-external-call behavior.
- Event completeness and exact evidence hash/source reference.
- Multisig simulation and wrong-network transaction rejection.
- Operational tabletop for reviewer error, compromised key, disagreement, delayed outcome, and incorrect submitted vector.

## Deliverables

- `ManualResolutionController` contract and bindings.
- Resolution packet schema and hashing tool.
- Admin CLI/script with simulation and exact transaction preview.
- Four-eyes review checklist and incident runbook.
- Resolution dashboard data contract/event specification.

## Exit criteria

- [ ] Only the resolution-admin multisig can finalize a payout.
- [x] Only one structurally valid payout can be reported per market.
- [x] Immutable mapping and awaiting-resolution state are enforced.
- [x] Evidence hash, source reference, caller, vector, and timestamp are auditable onchain.
- [x] All claims redeem correctly after each allowed outcome.
- [x] No watcher, signer network, bridge, proof, or automatic trigger exists.

## Non-goals

- Onchain verification of Polygon.
- Safety-delay proposal/challenge machinery.
- Admin correction after finalization.
- Permissionless or automatic resolution.
