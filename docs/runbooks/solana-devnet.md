# Solana Devnet deployment

This pipeline deploys the Rust program, creates the mock quote/crypto mints and
eight mock issuer tokens (replicas of the mainnet xStocks, Ondo and Remora
Token-2022 configurations for NVDA, TSLA and SPY), wraps Devnet SOL, allocates
every asset to the deployer's associated token accounts, and initializes the
protocol configuration. It does **not** create markets, deposit
wallet balances into protocol custody, deploy EC2 services, or approve production
use. Existing migration/security limitations still apply.

The deployed backend HTTPS origin is `https://api-solana.probabl.trade` for both
`DEVNET_API_URL` and `DEVNET_INDEXER_URL`. EC2, Cloudflare DNS, Certbot renewal and
local UI configuration are documented in the [backend runbook](../../ops/ec2/solana/README.md).

## Wallet and prerequisites

Use a dedicated Devnet wallet, never a wallet that holds real assets. Put its
private key in the ignored repository-root `.env.devnet`, not in chat, shell
arguments, source control, CI logs, browser configuration, or backend services.

```sh
# Do not overwrite an existing env file.
cp -n .env.devnet.example .env.devnet
chmod 600 .env.devnet
```

Fill `DEVNET_DEPLOYER_PRIVATE_KEY` in your editor. Supported formats are a
base58-encoded **64-byte** Solana secret key or a JSON array of exactly 64 integer
bytes. A seed phrase, 32-byte seed, public key or EVM private key is not accepted.
The public half is checked against the private half. There is no default-wallet
fallback and no need to change `solana config` or `Anchor.toml`'s local provider.

Required on PATH: Bun 1.3.14, Rust 1.97.1, Anchor CLI 1.1.2, Solana/Agave CLI
3.1.10, and the SBF build toolchain. For a newly provisioned machine, fetch the
locked Rust dependencies before the offline contract build:

```sh
bun install --frozen-lockfile
cargo fetch --locked
bun run devnet:build
bun run typecheck
bun run test
bun run devnet:rehearse
```

Keep `target/deploy/conditional_stocks-keypair.json` securely backed up and private
(`chmod 600`); its public key must match the compiled program ID:

`8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg`

This is a **different key** from the wallet you put in `.env.devnet`. The program
signer establishes the program address; your wallet pays fees and becomes its
upgrade authority. If the program signer is missing, restore it from backup.
Generating a replacement or running `anchor keys sync` changes the address and
requires a separately reviewed migration of Rust, SDK, IDL and deployment state.
The pipeline refuses a mismatching key rather than silently changing addresses.

## Prepare, fund, execute, verify

Run from the repository root:

```sh
bun run devnet:prepare
bun run devnet:plan
# Optional single 2-Devnet-SOL faucet request; funding is not guaranteed:
bun run devnet:airdrop --execute
bun run devnet:plan
# Only once the plan reports sufficient Devnet SOL:
bun run devnet:deploy --execute
bun run devnet:verify
```

To deploy a fresh program while reusing an already verified set of these mock
mint identities, preserve their private mint signer files under the new output
directory and prepare once with `DEVNET_REUSE_EXISTING_ASSETS=1`. This explicit
mode never creates, mints, wraps, or tops up an asset. It still verifies every
mint's address, token program, decimals, authority, Token-2022 extension policy,
metadata, and deployer token account before program configuration is initialized.
The default mode retains the stricter one-time issuance checks.

`prepare` checks the network, build/IDL/program identity and signer, then writes
stable mint addresses, a resumable buffer key and a hashed deployment plan. It
does not send transactions. `plan` reports public addresses and a conservative
funding budget in **lamports** (1 SOL = 1,000,000,000 lamports). The budget includes
the larger of upload-buffer/program-data rent, separate program-account rent,
token/config rent, 0.1 wrapped SOL, and a 0.1 SOL fee reserve. Loader-v3 returns the
buffer's lamports to the payer before creating ProgramData, so rent is not counted
twice. On retry, only an exactly sized, loader-owned buffer controlled by this
deployer receives credit. Program-account rent and fee reserves remain separate.
Fixture funding is conservatively estimated; a
single faucet request is generally insufficient for a program of this size.
Use the [official Solana faucet](https://faucet.solana.com/) or transfer existing
**Devnet** SOL to the printed deployer address. Do not buy/send mainnet assets.
The script does not loop around faucet limits or rotate wallets.

`deploy` refuses insufficient funding before any chain allocation. It uploads
the prepared executable with an explicit program signer, fee payer, buffer,
upgrade authority and RPC; waits for finalized, byte-exact read-back; creates
fixtures; initializes config; and verifies the result. It does not automatically
upgrade an existing program with different bytes or another authority.

Public-network uploads default to the CLI's TPU/QUIC transport, avoiding bulk
write transactions through the public RPC request limits. Set
`DEVNET_UPLOAD_TRANSPORT=rpc` only for an RPC provider that permits upload traffic
or when validator-direct networking is unavailable. Both modes use the same
genesis guard, buffer, signer, preflight and finalized verification; no program
verification or fee checks are skipped. Local rehearsals default to RPC mode.

If both bulk RPC and validator-direct uploads fail, use the paced fallback:

```sh
DEVNET_UPLOAD_TRANSPORT=rpc-paced bun run devnet:deploy --execute
```

This sends at most one 900-byte loader write every 700 ms, in batches of 16,
with preflight enabled and no automatic RPC rebroadcast flood. It compares the
existing buffer bytes to the prepared artifact, so it only writes missing or
different chunks, then waits for a byte-exact finalized buffer before handing
off to the CLI for normal ELF verification and deployment. It does not change
the program or buffer authority. Rate-limit/confirmation failures stop with the
same recoverable buffer and receipts; respect the provider's cooldown before
retrying. It takes several minutes for this artifact on the public RPC.

The RPC must use HTTPS and return the pinned Devnet genesis:
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
There is no environment override for this pin. Mainnet, Testnet and localhost are
rejected by the public deployment CLI. Every network mutation requires
`--execute`; `verify` only reads the chain and refreshes local records/env exports.

## Assets in the deployer's wallet

| Label  | Standard                                              | Decimals | Initial wallet balance |
| ------ | ----------------------------------------------------- | -------: | ---------------------: |
| USDC   | Classic SPL mock                                      |        6 |              1,000,000 |
| BTC    | Classic SPL mock                                      |        8 |                  1,000 |
| ETH    | Classic SPL mock                                      |        9 |                 10,000 |
| SOL    | Canonical wrapped Devnet SOL, classic SPL             |        9 |                    0.1 |
| NVDAx  | Token-2022 xStocks replica (issuer controls 63)       |        8 |                 10,000 |
| NVDAon | Token-2022 Ondo replica (issuer controls 62)          |        9 |                 10,000 |
| NVDAr  | Token-2022 Remora replica (issuer controls 47)        |        9 |                 10,000 |
| TSLAx  | Token-2022 xStocks replica                            |        8 |                 10,000 |
| TSLAon | Token-2022 Ondo replica                               |        9 |                 10,000 |
| TSLAr  | Token-2022 Remora replica                             |        9 |                 10,000 |
| SPYx   | Token-2022 xStocks replica                            |        8 |                 10,000 |
| SPYon  | Token-2022 Ondo replica                               |        9 |                 10,000 |

SOL cannot be minted like a mock token. The pipeline transfers 0.1 Devnet SOL
into its canonical wrapped-native associated account and calls `SyncNative`.
Native fee SOL remains in the same wallet separately. The mint address is
`So11111111111111111111111111111111111111112`; the mint's zero supply field is
normal for native SOL and is not a record of wrapped-account balances.

Issuer mocks are built by `scripts/solana/mock-issuers.ts` with the real Token-2022
instructions, in the mainnet extension order: MetadataPointer/TokenMetadata,
PermanentDelegate (not Ondo), DefaultAccountState (initialized), ScaledUiAmount
(realistic multipliers, e.g. ≈1.0017 for xStocks), Pausable, ConfidentialTransferMint
(no auto-approve) and an unset TransferHook (not Remora). The deployer is the mock
issuer authority (mint, freeze, pause, multiplier, metadata) so pause, dividend and
corporate-action behaviour can be rehearsed. There is no fee-bearing stock mock on
Devnet: Token-2022 rejects a transfer fee next to ConfidentialTransferMint. Each
pool admits exactly its mock's issuer controls (see
[the compatibility matrix](../TOKEN_COMPATIBILITY.md)). These are development
choices, not issuer or production policies. Their public mint addresses belong in
`DEVNET_ISSUER_MOCK_MINTS` (`packages/shared/src/spot-prices.ts`) once prepared, so
the UI can show the mainnet counterpart's reference price.

Classic USDC/BTC/ETH labels are recorded in the manifest; they do not have
Metaplex metadata. Some wallets will show only their mint addresses. Import the
mint addresses from the deployment record if needed. These are **not** real USDC,
BTC, ETH, issuer stock tokens, backed RWAs or tokens carrying stock rights. Testing
these fixtures does not establish support for every Token-2022 extension/issuer;
see [the compatibility matrix](../TOKEN_COMPATIBILITY.md).

The mock USDC mint is the configuration's quote token. The deployer is the admin,
market admin, guardian and resolution admin; protocol maker/taker fees start at
zero. There are no automatically listed markets or manufactured resolution
conditions. Create reviewed Devnet markets through the native admin workflow
after the API/indexer are configured. `scripts/solana/seed-devnet-markets.ts --execute`
seeds one market per asset (NVDA, TSLA, SPY) per pinned event, each listing that
asset's issuer mocks as base legs (creation evidence → `initializeMarketVaults`
with the ordered issuer list → open).

## Records, retries and recovery

The default `.local/devnet/` is ignored and private (0700); files are 0600:

| File              | Purpose / sensitivity                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| `plan.json`       | Stable mint/ATA identities, exact allocations, source/IDL/artifact hashes   |
| `mints/*.json`    | **Private mint signers**; securely back up, never publish                   |
| `buffer.json`     | **Private upload-buffer signer**; retained for interrupted uploads          |
| `journal.json`    | Transaction receipts, signed payloads, finalization/recovery state; private |
| `deployment.json` | Public addresses, current balances, authority and executable verification   |
| `backend.env`     | Server deployment settings; may contain a private RPC credential            |
| `ui.env`          | Browser-safe deployment settings; never contains the wallet key             |
| `pipeline.lock`   | Exclusive writer PID/time; normally removed on exit                         |

Never publish the directory as a whole. Back it up securely together with the
program signer; do not delete it to “retry.” Resubmit the same `deploy --execute`
command with the same wallet, artifact and directory after a temporary failure.
The buffer and mint addresses stay stable. Token creation, metadata, ATA creation
and initial mint are atomic per asset; reruns verify instead of minting again.
The mock allocations are one-time fixtures, not balance targets. Tokens that
you transferred/burned are not replaced, and closing an already-recorded wrapped
SOL account does not wrap more SOL on a later run.

Pending transactions block resubmission until finalized or expired. An ambiguous
expired SOL-wrap receipt requires manual review; the script refuses to guess
whether native SOL was already wrapped and spent. Partially initialized or
otherwise unexpected mint/account state also fails closed. If a process is
force-killed, inspect the recorded PID and any Solana child process before
manually removing **only that stale lock**. Do not run concurrent deployments
against the same program from separate directories/machines.

The CLI's payer signer is materialized only in a private temporary directory for
the Solana subprocess, removed in `finally`, and omitted from the child
environment. Normal exceptions clean it up; a machine crash/SIGKILL can leave a
0600 file under the OS temporary directory named `probabl-devnet-signer-*`.
Check/remove only the identified orphaned directory after confirming the process
has stopped. Never enable shell tracing or print `.env.devnet` to debug a failure.

If prepared contract source, dependency locks, IDL or executable change, the
pipeline stops. Preserve the old records; do not overwrite them to bypass a
failed check. A changed executable at an already deployed address requires a
separate explicitly authorized upgrade procedure; this initial-deployment
pipeline intentionally does not provide one.

## Backend and local UI handoff

After verification, `backend.env` supplies matching RPC/program/config/genesis
and API/indexer addresses. `ui.env` supplies matching public deployment values.
Set `DEVNET_API_URL` and `DEVNET_INDEXER_URL` to your EC2 HTTPS origins or local SSH
tunnel origins, then rerun `devnet:verify` to regenerate exports. Configure
`DEVNET_UI_ORIGINS` for the actual local public/admin browser origins.

For this deployed instance, `apps/admin-ui/.env.example` contains the public
Devnet program/config/genesis and HTTPS backend settings. Copy it to
`apps/admin-ui/.env.local` if that file does not exist, then run
`bun run dev:admin-ui` from the repository root. Restart the UI after changing
public settings: Next embeds `NEXT_PUBLIC_*` values in the browser bundle.
Never load the private root `.env.devnet` into a UI process. An explicit shell
or `--env-file` setting takes precedence over `.env.local`; do not mix the local
validator's `.local/solana.env` with this Devnet configuration.

Operator access is checked against the live Solana configuration account after
verifying the genesis hash and account owner. The public market/resolution admin
addresses are hints only; they do not grant access. A missing config/genesis or
failed RPC lookup must be corrected/retried, not treated as a blocked wallet.

The admin creation and resolution forms accept a **Polymarket market slug**
(for example `clarity-act-signed-into-law-in-2026`), not a Gamma ID or full URL.
For multi-market events, use the individual market's slug; the UI does not guess
which child market an event refers to. The admin UI's server-side gateway uses
Gamma's `/markets/slug/{slug}` endpoint, then submits the returned canonical ID
to the existing authenticated API/ingestor metadata flow. It verifies that the
saved snapshot's slug, Gamma ID, condition, and outcome mapping match the lookup.
Operator credentials are sent only to our API, never to Gamma. The EC2 API and
ingestor still store canonical IDs and need no change for this UI adapter.

`DEVNET_BROWSER_RPC_URL` defaults to the public Devnet RPC even if the backend
uses a private RPC provider. Anything assigned to it is exposed in the browser;
use a browser-restricted public credential if your provider requires one.

These generated files are **base configuration**, not a complete EC2 deployment.
For this Devnet setup, `.env.devnet` contains the private `DATABASE_URL` with a
password placeholder for the Tokyo Aurora PostgreSQL cluster. Replace
`REPLACE_WITH_URL_ENCODED_DB_PASSWORD` with the URL-encoded database password.
Port 5432 is assumed because the supplied connection snippet specified port 0;
confirm the actual port in the cluster's connectivity settings if it is custom.
The URL enables `sslmode=verify-full` using the checked-in public Tokyo RDS CA
bundle under `certs/`. Its absolute `sslrootcert` path must match the host running
the service. No AWS SDK/region setting is needed for this password-based `pg`
connection.

Once the password is filled and network access to RDS is available, a read-only
TLS/authentication check can be run from the repository root:

```sh
bun --env-file=.env.devnet packages/db/scripts/verify-connection.ts
```

Do not use `solana:dev` for RDS; that runner is localhost-only. Supply the database
setting to the API/indexer alongside the generated non-wallet `backend.env`
settings using a separate server-owned env file. Do not copy the entire
`.env.devnet` into backend processes: it also contains the deployer wallet key.
Starting these services initializes/writes database tables; the connection check
above does not. Run services only against the intended Devnet database, not a
production database or a test runner's disposable database.

On EC2, use a separate server-owned env file for `DATABASE_URL` (with the server's
certificate path), evidence persistence/
`EVIDENCE_PUBLIC_BASE_URL`, and any optional reference-data service secrets. The
generated files are overwritten on verification, so do not append server secrets
to them. Run native `start:api` and `start:indexer`. Keep the deployer private
key off EC2 and out of the UI.

The UI must be built/run with `ui.env`'s `NEXT_PUBLIC_*` values and use a browser
wallet set to Devnet. This step provisions balances; it does not by itself test
the complete API/indexer/UI trading product.

## Rehearsal and CI boundary

`bun run test:devnet-pipeline` runs fast, chain-free policy/storage/recovery tests.
They are included in `test:ts` and the existing CI host-verification job.

`bun run devnet:rehearse` starts a fresh localhost validator, creates a local-only
wallet, performs an actual upgradeable-loader deployment, initializes every asset
balance (including the issuer replicas' extension sets) and protocol config, and checks repeated runs
after spending/unwrapping. It stops only its own validator and retains diagnostic
ledgers/fixtures under `.local/`. It never uses `.env.devnet`'s wallet. Default RPC
port is 18997; set `DEVNET_REHEARSAL_PORT` to an unused port if needed. It needs a
matching built artifact/program signer. The validator integration test is skipped
in ordinary host CI unless explicitly enabled against a fresh localhost RPC.

Public Devnet deployment is deliberately a manual promotion using the commands
above, not an automatic push/PR job. Do not put deployment secrets into untrusted
CI builds. Contract coverage is not 100%, and this deployment rehearsal is not a
security audit or a guarantee of an exploit-free program.

Protocol references: [Solana deployment and authorities](https://solana.com/docs/programs/deploying),
[Agave 3.1.10 buffer rent reuse](https://github.com/anza-xyz/agave/blob/v3.1.10/programs/bpf_loader/src/lib.rs),
[wrapped SOL / SyncNative](https://solana.com/docs/tokens/basics/sync-native),
and [Devnet versus Testnet](https://solana.com/docs/references/clusters).
