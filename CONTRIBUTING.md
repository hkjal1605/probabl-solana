# Contributing

Use Bun 1.3.14, the pinned Rust toolchain, Anchor and Agave. Install only from the committed lockfile:

```bash
bun install --frozen-lockfile
bun run check
bun run build:contracts
```

Application and service code is strict TypeScript and formatted/linted by Biome. The Solana program and accounting crate use `cargo fmt` and `cargo test`.

Program changes require positive and adversarial tests, a local-validator rehearsal, and updated cost measurements. Rebuild the Anchor IDL and keep the SDK in sync with the program.

Markets list up to three issuer legs (see `docs/multi-issuer-markets.md`). Changes touching custody, matching or issuer admission must keep the multi-leg cases covered: the SBF `multi_issuer` and host `issuer_policy` Rust tests, and the validator suite `packages/solana-client/test/multi-issuer-validator.test.ts`, which uses real Token-2022 CPIs on mock issuer mints from `scripts/solana/mock-issuers.ts` (replicas of the mainnet fixtures in `packages/solana-client/test/fixtures/`). Validator transactions that use an address lookup table only land once the table's entries are finalized.

The indexer and API stream chain state over Yellowstone gRPC. Run application and indexer validator suites against a validator started with the plugin (`bun scripts/solana/yellowstone.ts` prints the `--geyser-plugin-config` flag and the `YELLOWSTONE_GRPC_URL` to export). Changes to `place` must keep the stale-plan cases covered: skipped or capped makers, absent credit frames and the resting race check (`g_*` tests in `multi_issuer`), plus the relaxed guard in `protocol-core`.

Do not add KYC/access-gating fields, automatic market creation, Polygon watchers, bridges, cross-chain messages, or automated resolution. These require an explicit later-version product decision.

Never commit private keys, RPC credentials, production evidence packets, or unreviewed deployment manifests. Preserve unrelated working-tree changes and document any accepted dependency/security exception.
