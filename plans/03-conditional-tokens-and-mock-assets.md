# Milestone 03 — Conditional Tokens and mock assets

## Implementation status — 2026-09-04

The npm-pinned Gnosis Conditional Tokens 1.0.3 deployment bytecode is used directly by the Foundry integration fixture. Tests cover split, merge, YES/NO/invalid redemption, raw-balance conservation across multiplier changes, paused tokens, unsolicited claim rejection, fee-on-transfer and false-return rejection, and atomic/recoverable failure for unsupported empty-return tokens. Long-running independent invariant campaigns and exact production-token testnet validation remain pre-audit launch gates.

## Goal

Establish and prove the collateral primitive: one unit of ERC-20 collateral can be split into complementary YES/NO ERC-1155 claims, recombined, and redeemed without violating conservation.

## Dependencies

- Milestone 02 schemas and golden vectors.

## Scope

### Conditional Tokens integration

- Pin and build the selected audited Gnosis Conditional Tokens implementation.
- Wrap integration calls only where needed; do not create a proprietary payout ledger.
- Define deterministic question, condition, collection, and position ID derivation.
- Ensure contracts can safely receive ERC-1155 claims.
- Document the local oracle relationship: the future `ManualResolutionController` is the condition oracle.

### Mock assets

Implement test-only assets for:

- 18-decimal mock USDG;
- 18-decimal mock Stock Token;
- false-return ERC-20;
- no-return ERC-20 if the test framework supports it;
- fee-on-transfer or rebasing token used only to prove that unsupported collateral is rejected;
- paused/reverting Stock Token;
- multiplier metadata changes without raw-balance rebasing.

### Collateral operations

Prove these raw-unit identities:

```text
X collateral -> X YES + X NO
X YES + X NO -> X collateral
winning claims -> payout share of collateral
```

Cover stock and USDG collateral independently under the same binary condition.

## Security properties

- Issued claims never exceed locked collateral for a condition/collateral pair.
- Split and merge cannot cross collateral tokens or condition IDs.
- A condition can report payouts once.
- Only the configured oracle can report payouts.
- ERC-1155 receiver callbacks cannot reenter partially updated state.
- Unsupported token mechanics fail at registration or transfer rather than silently breaking accounting.

## Tests

- Unit tests for prepare, split, merge, YES redeem, NO redeem, and invalid redeem.
- Stateful fuzzing of random split/merge/redeem sequences.
- Multiple users and both collateral assets.
- Zero, minimum, maximum, and invalid index-set cases.
- Malicious ERC-20 and ERC-1155 callback cases.
- Differential totals: collateral locked versus outstanding redeemable claims.
- Multiplier changes proving raw conservation remains unchanged.

## Deliverables

- Pinned CTF dependency and reproducible build.
- Mock asset suite.
- Reusable CTF integration test harness.
- Collateral-conservation invariant suite.
- Documentation of supported token assumptions.

## Exit criteria

- [x] Split, merge, and all three resolution outcomes pass deterministic tests; split/merge conservation is fuzzed.
- [ ] Collateral conservation holds across long randomized sequences.
- [x] Token failure modes are handled safely.
- [x] Raw balances remain conserved across mock multiplier changes.
- [x] No admin can seize registered collateral through a recovery function.
- [x] No identity-based ERC-1155 transfer restriction is introduced.

## Non-goals

- Orders or order matching.
- Market registry state.
- Manual resolution UI/evidence workflow.
- Production asset registration.
