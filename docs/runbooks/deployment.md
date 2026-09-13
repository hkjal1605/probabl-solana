# V2 raw-unit-ratio deployment runbook

Public production remains prohibited until the gates in [`SECURITY.md`](../../SECURITY.md) are complete. The owner's explicitly accepted, developer-funded internal mainnet experiment is a separate mode documented in [internal-mainnet-testing.md](internal-mainnet-testing.md).

This is a new, non-upgradeable deployment. Follow the [raw-unit migration checklist](../architecture/raw-unit-ratio-v2.md); do not reuse v1 signatures, manifests, matcher checkpoints or service databases. The `deploy:v1` / `verify:v1` aliases are deprecated and invoke the current v2 tooling, not the historical v1 protocol.

## Network and build checks

Robinhood's official configuration currently lists mainnet chain ID `4663`, testnet `46630`, and ETH as gas. Re-verify these values and every token address immediately before deployment using the [official connection documentation](https://docs.robinhood.com/chain/connecting/).

The official documentation describes EVM compatibility but does not pin a hardfork target. The repository therefore builds conservative `paris` bytecode. Prove every creation/runtime bytecode on Robinhood testnet before mainnet.

```bash
bun install --frozen-lockfile
bun run check
bun run build:contracts
bun run generate:bindings
```

Record the exact Bun, Forge, Solidity, dependency-lock, and repository commit identifiers.

## Deploy

Copy `packages/contracts/.env.example` into an untracked environment file. Never store a real key in the repository. `INITIAL_ADMIN` must temporarily equal the deployment account because the registry and exchange require one-time wiring transactions. `FINAL_ADMIN` and the four operational roles must be six distinct addresses; use the intended governance and operational multisigs.

M-02 remains open. RH mainnet `4663` requires `DEPLOYMENT_MODE=internal-mainnet` and `INTERNAL_MAINNET_RISK_ACK=I_ACCEPT_M02_AND_DEPENDENCY_RISK_FOR_INTERNAL_TESTING`. This only enables an explicitly acknowledged internal experiment, not public production approval. Manifests preserve the risk acceptance; verification requires it. All other non-development chains remain rejected. An allowlisted chain ID alone does not authenticate an RPC.

Use an independently verified existing CTF address, or explicitly set `DEPLOY_CONDITIONAL_TOKENS=true` to deploy the pinned Gnosis 1.0.3 artifact. The installed CTF runtime must have keccak256 `0xadf1ee4719c637975ba08765e3a1187f2fb865c9b17386005960a81ff29cfcc7`; arbitrary nonempty code is rejected before dependent contracts are deployed. USDG and Stock Token exact-bytecode/behavior approval is still a separate release gate, not inferred from their decimal count.

```bash
bun --filter @conditional-stocks/contracts deploy:v2
```

The script checks compiler settings and source hashes against build metadata, simulates each constructor to derive the expected immutable-bearing runtime, compares installed bytecode before configuring dependencies, and checks the wiring/role graph. Use artifacts from a clean trusted build: metadata matching is not protection against a malicious compiler or forged artifact. It waits for every receipt, schedules the two-day default-admin transfer to `FINAL_ADMIN`, and writes `packages/contracts/deployments/<chainId>/v2-<authority-address>.json`. Historical manifests are preserved. The manifest includes source/lock digests, constructor arguments, deployment and configuration transaction/block hashes, role assignments, handover timing, and `productionApproved: false`.

## Verify and hand over

1. Verify every source and constructor argument on Blockscout.
2. Compare runtime bytecode hashes with a clean reproducible build.
3. Read back every immutable dependency and role.
4. Confirm the exchange's order validator, settlement, and IOC router cannot be changed.
5. Verify the pending default administrator and acceptance timestamp, then have `FINAL_ADMIN` accept only after the two-day delay.
6. Revoke any unintended deployer operational role.
7. Set `DEPLOYMENT_MANIFEST` to the generated file and run `bun --filter @conditional-stocks/contracts verify:v2`. This is read-only; it checks source/lock identity, reconstructed runtimes, deployment receipts/input, wiring, role membership for every historically granted account, completed handover, and absence of deployer administration. It requires an RPC providing complete role logs from the verified authority deployment block. Independently reconcile the evidence and multisig ownership. The market creation CLI requires this verification and rejects incomplete handovers.
8. Create a zero-value-free test market through the reviewed manual workflow and exercise open/cancel, freeze/release, all payout vectors on separate test conditions, merge, and redemption.
9. Publish the final manifest, handover acceptance receipt, and audit references. The manifest's pending-admin fields record deployment-time history; the verifier reads current chain state.

The deployment script never creates a market and never resolves one. Those remain separate explicit admin actions.

For an isolated regression rehearsal, start a fresh Anvil on loopback chain 31337, then run `AUDIT_ANVIL_URL=http://127.0.0.1:18546 AUDIT_DEPLOYMENT_OUTPUT=<new-directory> bun packages/contracts/scripts/rehearse-deployment.ts`. It uses only public Anvil development keys, advances local time, and temporarily alters local runtime code to test fail-closed verification. Never point this test at a network holding value.
