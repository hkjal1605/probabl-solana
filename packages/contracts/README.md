# Protocol contracts

The contracts implement Conditional Stocks v2 raw-unit pricing. Read [the v2 unit/migration specification](../../docs/architecture/raw-unit-ratio-v2.md), [the core lifecycle architecture](../../docs/architecture/protocol-v1.md) and [`SECURITY.md`](../../SECURITY.md) before changing them.

## Local verification

```bash
forge fmt --check
forge lint
forge build --no-cache
forge build --sizes --skip test
forge test
FOUNDRY_PROFILE=ci forge test
forge coverage --ir-minimum --report summary
```

The suite deploys the bytecode from the pinned `@gnosis.pm/conditional-tokens-contracts@1.0.3` artifact. It does not replace CTF with a simplified mock.

Run the uncached build after lint: Forge 1.7.1 can otherwise retain ABI-only test artifacts and silently omit a suite. Do not run builds, lint, coverage, and test commands concurrently against the same artifact/cache directories.

Stateful trading and lifecycle handlers maintain independent escrow/order accounting across randomized calls. CI runs 1,000 sequences of depth 128 per invariant; unexpected handler reverts fail the run. The bounded symbolic arithmetic proofs are in `audit/2026-09-06/remediation/verification/prove-accounting.py` (Python plus `z3-solver`). These are explicitly scoped model proofs, not a whole-EVM proof or independent security certification. M-02 remains a production blocker.

The registry no longer calls `decimals()`. All accounting is raw; prices are raw quote/raw base ratios scaled by `1e18`. Canonical USDG has 6 decimals, so a stock18 token at 200 USDG uses price `200000000`. See the v2 specification for the mandatory fresh-deployment migration. The pinned CTF still requires boolean-returning `transfer` and `transferFrom`: empty-return token failures must roll back without trapping escrow.

Compiler settings are deliberately fixed in `foundry.toml`: Solidity 0.8.30, `paris`, IR pipeline, 7,500 optimizer runs, and metadata hash disabled. All production runtime bytecodes must remain below EIP-170. `.gas-snapshot` records the current regression baseline.

## Real-token Anvil fork diagnostic

```bash
bun run test:rh-fork
```

This integration test uses the exact RH block number/hash pinned in `scripts/test-rh-token-fork.ts`. It verifies canonical USDG/NVDA/TSLA identities, proxy/dependency bytecode and balances; exercises all 48 branch/funding/outcome combinations; and checks IOC/refunds, API, live indexer, matcher/worker, reconciliation and replay. It does not replace token code or storage. Issuer-policy changes, upgrades, future multipliers and Nitro-specific behavior are not certified.

The script owns a fresh Anvil instance on `127.0.0.1:18547`; it refuses an occupied port, retains fork chain ID `4663`, and always stops its instance afterward. A read-only loopback RPC gateway prevents upstream transaction submission. Only local fork holder impersonation and local ETH gas-balance changes are used. No real assets are moved, and the production deployment allowlist remains unchanged.

Each run writes a new timestamped evidence directory under `audit/2026-09-06/real-token-fork/evidence`. Exit `0` requires all selected compatibility checks to finish; exit `1` means incomplete/failed verification. Successful immutable RPC reads are cached verbatim with their block pin. Unavailable uncached historical state fails the run. A fresh pin requires an explicit source update and new evidence, never a silent fallback or mock token.

Generate bindings and finish builds before starting the fork harness. It runs two independent Ponder development indexers; codegen or imported-file writes during startup can trigger hot reload and invalidate the run. See the [final verification report](../../audit/2026-09-06/raw-unit-ratio/REPORT.md) for the exact passing pin and the separate open production gates.

## Administrative scripts

```bash
bun run deploy:v2
bun run verify:v2
bun run market:create
bun run market:prepare-resolution
bun run market:resolve
```

Market creation and resolution default to simulation-only and print exact calldata. Broadcasting requires the explicit `SUBMIT_ADMIN_ACTION=true` environment flag. Neither script fetches Polymarket state or automates an admin decision.

Creation additionally requires `DEPLOYMENT_MANIFEST` and a completed verified delayed admin handover. Preparation and finalization must use exactly the same payout vector, evidence hash, and URI; the commitment is chain/controller/market specific. Deployment tooling is restricted to local/testnet until independent M-02 clearance.
