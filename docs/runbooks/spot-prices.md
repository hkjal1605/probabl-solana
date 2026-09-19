# Jupiter spot references

Display only: no spot price affects order construction/matching, funding, vault
backing, split/merge, redemption, fees/caps, or outcome settlement. No contracts,
indexer schemas, oracle accounts or wallet permissions are changed.

## Runtime

The Solana API exposes `GET /v1/spot-prices?mints=<comma-separated mints>` (1–50).
It requests `https://api.jup.ag/price/v3` with a server-only `x-api-key` header.
The browser calls our API directly (no Next API pricing proxy), polls every 15s,
and shares React Query data. Pricing errors do not fail the markets query or
trading readiness. Markets with more than 50 distinct mints are split into batches.

Set `JUPITER_API_KEY` in the **API process's** private env. On EC2 that is
`.local/ec2/env/api.env`, not the root `.env.devnet` and not the UI env. Initial
staging copies this key only to the API. For an existing installation, update
that env without rerunning initial staging/rotating DB credentials, deploy the
code and restart only `probabl-sol-api`. No deployment is performed by this change.

`JUPITER_PRICE_RPC_URL` defaults to `https://api.mainnet-beta.solana.com`. It is
used only for mainnet `getGenesisHash` and `getBlockTime` reads. Configure a
mainnet-capable RPC here if the public endpoint is rate-limited. Never reuse a
devnet-only RPC. Neither RPC URLs nor provider response bodies are logged.

Set the UI's public `NEXT_PUBLIC_API_URL` to our backend origin (default:
`https://api-solana.probabl.trade`); rebuild/restart when changing it. For local
testing use `http://127.0.0.1:3000`. No Jupiter key belongs in a `NEXT_PUBLIC_*`
setting. The old provider key, if retained in an ignored operator env, is unused.

## Identity and devnet aliases

On mainnet any canonical mint is queried **as itself**, without a ticker or issuer
whitelist. Unknown or filtered-out tokens return unavailable, never zero or $1.
Provider coverage does not establish vault compatibility or token authenticity.

Only on the exact devnet genesis hash do we apply the public deployment aliases:

| Test asset | Mainnet reference mint |
| --- | --- |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Circle) |
| BTC | `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` (cbBTC) |
| ETH | `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` (Wormhole/Portal) |
| SOL | `So11111111111111111111111111111111111111112` (wrapped SOL) |
| TSLA | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` (TSLAx) |
| NVDA | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` (NVDAx) |
| SPY | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` (SPYx) |

Circle's official devnet USDC also aliases to mainnet Circle USDC. Other devnet,
testnet and localnet mints remain unmapped. The UI tooltip identifies mainnet
references for devnet tokens; no mainnet swaps, balances or transactions are used.
The price display has no provider branding or pricing-slot/timestamp details;
only stale, unverified or missing-price warnings remain below the price and USD label.

## Quality and units

Responses include source mint, source decimals, pricing block, actual block time,
retrieval time and status. We never use Jupiter `createdAt` as a price timestamp.
Prices older than 120s, or responses not refreshed for 60s, become stale. An RPC
failure/null block time/wrong genesis produces `age-unverified`, not a fake fresh
timestamp. The UI shows last-known prices with quality labels. Browser timers
expire prices even if polling fails or a background tab resumes.

Jupiter's numeric USD price is displayed unchanged, without pretending it is an
exact executable quote. Tokens using Scaled UI Amount/interest-bearing extensions
need verified price/balance-unit semantics before multiplying prices by raw-unit
balances. Therefore automatic whole-wallet USD estimates currently accept only
the reviewed ordinary-unit SOL/USDC/cbBTC/Portal ETH identities and their devnet
aliases. Stock references still display; an incomplete portfolio valuation is
withheld. This restriction is on valuation, not price lookup. No silent conversion
to a stock's underlying equity price or automatic multiplier is applied.

The backend deduplicates overlapping calls, batches at most 50 source mints,
paces Jupiter requests to at most 1/sec per process, bounds cache/queue entries
at 500, bounds block-time cache at 1000 and response bodies at 256 KiB, and applies
timeouts/global backoff. 401/403 never signs the user out; 429 respects bounded
Retry-After. Run one API process or coordinate this cache/limiter before scaling.

## Verification

`bun test apps/api/test/solana/jupiter.test.ts apps/ui/test/spot-prices.test.ts`

The tests use mocked transport, not live credentials, databases or transactions.
Historical spot charts remain unavailable: Price V3 returns current references,
not historical data. Provider omissions/stale swaps are not simulated as prices.

Sources: [Jupiter Price V3](https://developers.jup.ag/docs/price),
[pricing blocks](https://developers.jup.ag/blog/how-jupiter-prices-a-token),
[Wormhole mint list](https://github.com/wormhole-foundation/wormhole-token-list/blob/main/content/dest_solana.md),
[Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses),
[Coinbase cbBTC](https://www.coinbase.com/cbbtc),
[xStocks assets](https://docs.xstocks.fi/apis/openapi/assets),
[scaled-unit guidance](https://solana.com/docs/tokens/extensions/scaled-ui-amount/integration-guide).
