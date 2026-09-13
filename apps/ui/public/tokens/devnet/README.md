# Temporary Devnet token icons

Bundled display icons/monograms for the test mints in `src/lib/tokens/devnet.ts`.
These are not issuer-provided metadata or a claim that the mock stock tokens are
issued by Tesla, NVIDIA, or SPDR. The user-facing aliases (for example BTC instead
of the on-chain dBTC symbol) apply only to these exact mints on Solana Devnet.
SOL refers to the deployed wrapped-native mint; all values remain Devnet assets.

The registry is display-only. Token program, decimals, quantities, balances and
prices continue to come from the existing verified chain/indexer paths. Images
are served locally and require no external image service or metadata RPC calls.
Unknown mints and other genesis hashes retain the existing display fallback.

When redeploying test mints, update the hardcoded registry and its regression
tests from the new public deployment manifest. Never import `.local/` or an env
file containing private keys into the browser bundle.
