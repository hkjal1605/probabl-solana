# Milestone 04 — Market registry

## Implementation status — 2026-09-04

`MarketRegistry` implements role-gated manual creation, one immutable deployment-time USDG token, v2 raw-unit-ratio price configuration, immutable Polymarket mapping, CTF condition/position derivation, configuration caps, and the one-way lifecycle. It does not query token decimals; verified metadata is handled offchain. The controller is configured once and dependency-checked. The market-terms template and simulation-first creation CLI are present. Multisig/four-eyes behavior remains an operational workflow and cannot be proven by the contract.

## Goal

Implement manual admin-only creation of immutable stock/event markets, validated risk configuration, and the complete v1 lifecycle state machine.

## Dependencies

- Milestone 02 domain definitions.
- Milestone 03 CTF condition primitives.

## Market data

Store or emit:

- protocol version and Robinhood Chain ID;
- base Stock Token and quote USDG addresses and validated decimals;
- local CTF question and condition IDs;
- exact Polygon chain ID, Polymarket condition ID, YES/NO token/index mapping, and canonical reference;
- rules snapshot URI and content hash;
- opening time, cutoff, expected event/end time;
- price tick, base step, minimum notional, and wallet/market live open-order notional caps (filled exposure and direct CTF issuance excluded);
- `ManualResolutionController` address/version;
- creation block and admin action identifiers.

## Manual creation workflow

The contract cannot enforce human four-eyes review, but the admin workflow must:

1. Prepare a draft from manually entered or prefilled metadata.
2. Require a second operator to verify the condition ID, outcome orientation, rules, dates, stock, quote token, and caps.
3. Produce a signed/reviewed terms artifact and hash.
4. Submit `createMarket` through the market-admin multisig.
5. Re-read the emitted market and compare every immutable field with the approved artifact.

No public caller, API response, scheduler, or Polymarket ingestor may create a market. Opening after creation may follow the configured lifecycle policy but cannot change terms.

## State machine

Implement and test only valid transitions:

```text
Draft -> Scheduled -> Open -> Frozen -> AwaitingResolution
AwaitingResolution -> Resolved -> Redeemable -> Archived
```

`Draft` may remain an offchain admin-workflow state; the first onchain state can be `Scheduled` when `createMarket` succeeds. Specify who or what may trigger time-based opening, cutoff freezing, incident freezing, resolution-state changes, and archival. Freeze must be one-way for markets with fills unless a separately documented safe transition exists.

## Roles

- `MARKET_ADMIN_ROLE`: create/approve curated markets.
- `GUARDIAN_ROLE`: freeze or pause new trading only.
- Resolution authority is separate and added in milestone 08.
- Administration should be assigned to documented multisigs/timelocks, not personal hot wallets.

The market admin cannot edit open-market terms, resolve payouts, or transfer collateral.

## Tests

- Market ID matches golden vectors.
- Admin-only creation and unauthorized-call rejection.
- Duplicate market/condition handling.
- Wrong token, decimals, chain ID, index mapping, time, tick, step, and cap rejection.
- All valid and invalid state transitions.
- Immutability after creation/opening.
- Freeze behavior and event completeness.
- Fuzzed market configuration boundaries.

## Deliverables

- `MarketRegistry` contract and interface.
- Admin creation script/CLI dry run.
- Human-readable market-terms template.
- Full event schema and generated bindings.
- Unit, fuzz, and state-machine tests.

## Exit criteria

- [x] Only the market-admin authority can create a market.
- [x] Every market field is reproducible from the terms artifact and event.
- [x] Market identity and Polymarket mapping cannot change after creation.
- [x] State transitions reject trading outside `Open`.
- [x] Guardian freeze cannot resolve, seize, or rewrite anything.
- [x] No automated creation path exists.

## Non-goals

- Permissionless listings.
- Market resolution.
- Order escrow or matching.
- Multi-outcome or grouped Polymarket markets.
