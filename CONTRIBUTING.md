# Contributing

Use Bun 1.3.14, the pinned Rust toolchain, Anchor and Agave. Install only from the committed lockfile:

```bash
bun install --frozen-lockfile
bun run check
bun run build:contracts
```

Application and service code is strict TypeScript and formatted/linted by Biome. The Solana program and accounting crate use `cargo fmt` and `cargo test`.

Program changes require positive and adversarial tests, a local-validator rehearsal, and updated cost measurements. Rebuild the Anchor IDL and keep the SDK in sync with the program.

Do not add KYC/access-gating fields, automatic market creation, Polygon watchers, bridges, cross-chain messages, or automated resolution. These require an explicit later-version product decision.

Never commit private keys, RPC credentials, production evidence packets, or unreviewed deployment manifests. Preserve unrelated working-tree changes and document any accepted dependency/security exception.
