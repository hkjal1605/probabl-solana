# Milestone 00 — Dependency validation

## Goal

Prove or explicitly isolate every external assumption that could invalidate the v1 custody, token, deployment, or data architecture before substantial implementation begins.

## Inputs

- Source-of-truth implementation plan.
- Current official Robinhood Chain, Stock Token, wallet, and oracle documentation.
- Current official Polymarket market-data and contract documentation.
- Candidate infrastructure providers.

## Scope

### Robinhood Chain

- Verify current mainnet and testnet chain IDs, RPC behavior, explorer support, gas token, finality behavior, and sequencer status interfaces.
- Identify authoritative registries for USDG, supported Stock Tokens, multipliers, and price feeds.
- Confirm contract-size, gas, calldata, event, and ERC-4337 constraints relevant to v1.
- Verify at least two independent RPC providers for operational redundancy.

### Asset compatibility

- Select mock USDG and mock Stock Token behavior for local/testnet development.
- For each candidate real Stock Token, inspect decimals, transfer behavior, pause controls, multiplier semantics, return values, and restrictions that can cause transfers to revert.
- Confirm whether Stock Tokens can be held by `ConditionalTokens` and `ConditionalExchange` contracts.
- Record how splits, dividends, reverse splits, mergers, delistings, and token pauses affect raw and displayed units.
- Confirm USDG decimals and transfer behavior. V2 uses raw-unit-ratio prices without onchain decimal scaling; exact metadata is verified at the indexer/API input and display boundaries. See `docs/architecture/raw-unit-ratio-v2.md`.

### Wallet and transaction infrastructure

- Test candidate embedded smart-wallet providers on Robinhood testnet.
- Verify EIP-712 signing, ERC-20 approvals, ERC-1155 approvals, batching, sponsorship, fallback user-paid transactions, and transaction receipt tracking.
- Verify that the relayer/paymaster model cannot take custody or forge user orders.

### Polymarket data

- Verify event discovery, market metadata, CLOB REST, CLOB WebSocket, outcome token mapping, and resolved-market evidence sources.
- Capture three representative binary markets: YES, NO, and invalid/unknown if available.
- Confirm data-use rights or record the unresolved owner and decision deadline.
- Do not design or test any automatic settlement path; Polymarket resolution is evidence for a human admin workflow only.

### Deferred access controls

- Record that KYC/KYB, sanctions, geography, investor-status, tax-status, appropriateness, wallet allowlists, and restricted claim transfers are outside v1.
- Do not select or integrate compliance providers in this milestone.
- Record that adding restricted claims later requires a new contract version because v1 is non-upgradeable.

## Deliverables

- `docs/architecture/dependency-matrix.md` with owner, source, verification date, result, and expiry/recheck date.
- `packages/config` draft containing versioned chain and token configuration with no unverified production constants.
- Test transaction report for wallet, ERC-20, ERC-1155, and paymaster flows.
- Stock Token compatibility report including multiplier and corporate-action behavior.
- Polymarket sample-data fixtures for three reviewed binary conditions.
- Blocked-dependency register with workaround, owner, and impact.

## Verification

- Reproduce all network/address claims from authoritative sources.
- Run read-only contract calls against configured testnet assets.
- Execute a mock approval, transfer, ERC-1155 receive, and sponsored transaction on testnet.
- Validate that sample Polymarket metadata maps labels to the correct condition and token IDs.
- Have a second engineer review every production address and YES/NO mapping fixture.

## Exit criteria

- [ ] Robinhood testnet can run the required EVM, wallet, token, and event flows.
- [ ] Mock asset behavior and real-asset differences are documented.
- [ ] No unresolved issue requires redesigning the basic CTF custody model.
- [ ] At least one wallet/paymaster path works, with a user-paid fallback documented.
- [ ] Polymarket metadata and probability data can be consumed for display.
- [ ] Manual-only resolution and no-KYC v1 boundaries are recorded in the dependency matrix.
- [ ] Every unresolved external dependency has an owner and does not masquerade as completed work.

## Non-goals

- Deploying production contracts.
- Implementing exchange logic.
- Integrating KYC or compliance providers.
- Building Polygon watchers, bridges, proofs, or automatic resolution.
