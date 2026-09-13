# Contributing

Use Bun 1.3.14 and Foundry 1.7.1. Install only from the committed lockfile:

```bash
bun install --frozen-lockfile
bun run check
bun run build:contracts
```

Application and service code is strict TypeScript and formatted/linted by Biome. UI packages are intentionally out of scope for the current repository stage. Solidity is confined to `packages/contracts` and formatted by `forge fmt`.

Contract changes must preserve the fixed v1 decisions in the source plan, add positive and adversarial tests, run the pinned real CTF integration fixture, update `.gas-snapshot`, and keep every runtime below EIP-170. Regenerate TypeScript ABIs with `bun run generate:bindings`; never edit `generated.ts` manually.

Do not add KYC/access-gating fields, automatic market creation, Polygon watchers, bridges, cross-chain messages, or automated resolution. These require an explicit later-version product decision.

Never commit private keys, RPC credentials, production evidence packets, or unreviewed deployment manifests. Preserve unrelated working-tree changes and document any accepted dependency/security exception.
