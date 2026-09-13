# Deploy the probabl UI to Cloudflare Workers

This deploys **`apps/ui` only**, using the pinned OpenNext adapter and Wrangler.
Next.js remains Next.js; `bun run dev:ui` still runs on port 3001. The admin UI,
API, indexer, reconciler and Polymarket ingestor are
not deployed by this workflow. Backend services continue to share PostgreSQL.

## Prerequisites

- Bun 1.3.14 and Node.js 22 or newer; install from the repository root with
  `bun install --frozen-lockfile` (include dev dependencies for the build).
- A Cloudflare account with Workers enabled. Authenticate locally with
  `bunx --no-install wrangler login` from `apps/ui`. In CI, supply a scoped
  `CLOUDFLARE_API_TOKEN` with Workers deployment permissions and the correct
  `CLOUDFLARE_ACCOUNT_ID` as CI secrets. Never use `NEXT_PUBLIC_*` for credentials.
- For live functionality: reachable HTTPS origins for the API and indexer, a browser-accessible HTTPS
  chain RPC, and a public WSS endpoint for **our Polymarket ingestor**.
- For live functionality: actual deployed contract addresses on the selected chain. Optional deployment checks
  validate syntax/configuration, not deployed bytecode or backend readiness.

You can deploy the UI before these live-service settings exist. The default
deployment command does **not** run the environment preflight. Select **Try demo**
in the deployed UI to explore dummy data; live mode remains the default and will
not become functional until the real service/network settings are supplied.

The Worker is named `probabl-ui`. Set a different name in `wrangler.jsonc` if
needed, and update `WORKER_SELF_REFERENCE.service` to the same name. Initially
the address is `https://probabl-ui.<your-workers-subdomain>.workers.dev`.
Version preview URLs are disabled. Add a custom domain through the Cloudflare
dashboard when ready; changing the canonical UI origin requires a rebuild.

For internal mainnet testing, retain the existing deployment risk acknowledgment.
Neither the trading API nor the contracts whitelist tester wallets. Trading still
requires wallet authentication and valid owner-authorized orders; administrative
and internal service endpoints must retain their separate access controls. The UI
banner describes testing status, not an access restriction or production approval.

## Environment settings

Build-time settings go in `apps/ui/.env.production.local` for CLI builds, or in
Cloudflare **Workers Builds → Build variables and secrets**. Copy the names from
`apps/ui/.env.example`, but replace all localhost/example values for deployment.
Only put UI settings in this file, never the backend's complete `.env`.

| Setting | Purpose |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | Exact HTTPS UI origin, without a path; used for canonical social metadata. |
| `NEXT_PUBLIC_ROBINHOOD_CHAIN_ID` | The deployed chain ID. `31337` is rejected by the deployment preflight. |
| `NEXT_PUBLIC_ROBINHOOD_CHAIN_NAME` | Wallet network display name. |
| `NEXT_PUBLIC_ROBINHOOD_RPC_URL` | Browser-reachable HTTPS RPC; any provider key in this URL is public. Apply provider origin restrictions. |
| `NEXT_PUBLIC_BLOCK_EXPLORER_URL` | HTTPS explorer URL for that same chain. |
| `NEXT_PUBLIC_CONDITIONAL_TOKENS_ADDRESS` | Nonzero Conditional Tokens deployment address. |
| `NEXT_PUBLIC_EXCHANGE_ADDRESS` | Nonzero Exchange deployment address. |
| `NEXT_PUBLIC_ATOMIC_ORDER_ROUTER_ADDRESS` | Nonzero AtomicOrderRouter bound permanently to that exchange. User wallets send placement/fill transactions here. |
| `NEXT_PUBLIC_PAYOUT_VAULT_ADDRESS` | The exchange-created PayoutVault from the manifest; locally binds beneficiary withdrawals. |
| `NEXT_PUBLIC_POSITION_ROUTER_ADDRESS` | The PositionRouter from the same manifest; locally binds merge/redeem and ERC-1155 approval calldata. |
| `NEXT_PUBLIC_POLYMARKET_STREAM_URL` | WSS origin of our ingestor, without the stream path. The UI appends `/v1/polymarket/conditions/<id>/stream`. This is not Polymarket's upstream CLOB socket. |
| `NEXT_PUBLIC_LOG_LEVEL` | Optional `debug`, `info`, `warn`, `error` or `silent`; use `info` normally. Browser logs are visible to users. |

`NEXT_PUBLIC_*` values are compiled into the browser bundle. Updating runtime
variables alone cannot change the network, contracts, RPC, socket, or UI origin:
**rebuild and redeploy** after any change. Rebuild per environment, rather than
promoting an artifact with another environment's contract addresses.

Set these separately under the Worker's **Settings → Variables and Secrets**:

| Runtime setting | Purpose |
| --- | --- |
| `API_URL` | HTTPS backend origin, without `/v1`, credentials, query string or fragment. |
| `INDEXER_URL` | HTTPS indexer origin, without a path, credentials, query string or fragment. |
| `PROBABL_HOSTING` | Managed by `wrangler.jsonc` as `cloudflare`; do not override it in deployed environments. |

`API_URL` and `INDEXER_URL` may also be provisioned using `wrangler secret put`
with interactive input. Their actual values are deliberately not committed.
`keep_vars: true` preserves dashboard-managed runtime variables on redeploy.
If the Worker does not yet exist, provision its runtime settings immediately
after the first upload, before allowing testers to use live mode. Missing or
invalid upstream settings fail closed with HTTP 503; there is no deployed
localhost or demo-data fallback.

The UI must not receive `DATABASE_URL`, admin private keys, or ingestor internal
service tokens. It does not access PostgreSQL. There is no trading relayer key.
The build sanitizer removes OpenNext's bundled `.env` fallback values, including
values inherited from the monorepo root. Keep the sanitizer in every build path.
Do not use raw `opennextjs-cloudflare build` followed by deployment.

## Local development and Workers preview

Regular Next development is unchanged:

```sh
bun run dev:ui
```

For actual Workers-runtime preview, copy `apps/ui/.dev.vars.example` to
`apps/ui/.dev.vars`, adjust its local upstream ports, and configure local public
settings in `apps/ui/.env.local`. `.dev.vars` is local-only and ignored by Git.

```sh
bun run preview:ui:cloudflare
```

The default preview URL is `http://127.0.0.1:8787`. Demo mode needs no upstream
services or wallet; live mode needs the local backend stack. The preview builds
production JavaScript; it is not the hot-reload development workflow.

OpenNext requires the conventional `.next` build directory. Next 16 keeps dev
output in `.next/dev` and preserves it during builds. Do not run two production
builds concurrently. The isolated PostgreSQL rehearsal build remains supported
by its existing separate workflow.

## Verify and deploy

From `apps/ui`:

```sh
bun run test
bun run typecheck
bun run lint
bun run cf-typegen
bun run dryrun:cloudflare
bun run test:cloudflare
bun run deploy:cloudflare
```

The last command performs a fresh build, environment sanitization, and then
deployment, **without the environment preflight**. The root equivalent is
`bun run deploy:ui:cloudflare`. **Only that deployment step publishes the UI.**
The secret sanitizer and runtime upstream safeguards remain mandatory.

For an optional standalone configuration check, run `bun run check:cloudflare`
from `apps/ui`. To require that check before publishing, use
`bun run deploy:cloudflare:strict` there, or `bun run deploy:ui:cloudflare:strict`
from the repository root. Missing public settings do not block the default
command, but invalid values can still cause application/build errors. Adding
`NEXT_PUBLIC_*` settings later requires a fresh build and redeployment.

The local smoke test starts/stops its own workerd and mock upstreams, using
ephemeral loopback ports. It does not use production endpoints, wallets or a DB.
Wrangler's dry run reports compressed script size; compare it with the account's
current plan limit. `wrangler check startup` profiles local Worker initialization.
Regenerate `cloudflare-env.d.ts` when bindings or compatibility settings change.

For Cloudflare Git integration / Workers Builds, keep the **repository root**
as the project root so workspace packages and the Bun lockfile are available:

- Install: `bun install --frozen-lockfile` (or the equivalent Bun auto-install).
- Build: `bun run --cwd apps/ui test && bun run --cwd apps/ui typecheck && bun run --cwd apps/ui lint`.
- Deploy: `bun run deploy:ui:cloudflare` (this includes the build and sanitizer).
  Use `bun run deploy:ui:cloudflare:strict` if CI should enforce environment validation.
- Build watch paths: `apps/ui/**`, `packages/ui/**`, `packages/domain/**`,
  `packages/shared/**`, `packages/gateway/**`, `packages/orderbook/**`, `packages/contract-bindings/**`, `bun.lock`,
  `package.json`, `tsconfig.base.json`, and `biome.json`.

Do not replace the deploy command with plain `wrangler deploy` in CI, which
would bypass our build/sanitization workflow. Do not enable
automatic branch deployment of the live-configured UI to unprotected URLs.

## Backend integration and caching

The browser calls `/api/gateway/*` and `/api/indexer/*` on the UI origin. The
Worker forwards them to the configured upstreams. Gateway requests preserve
authorization, content type and idempotency keys, stream bodies, and do not
forward browser cookies or internal headers. The indexer tunnel only permits
the existing public routes; do not expose service-only endpoints through it.
Authentication is still enforced by the API, not the UI proxy.

Configure backend `API_AUTH_DOMAIN` / `API_AUTH_ORIGIN` for the intended wallet
sign-in domain/origin (normally the UI hostname/origin), with the same chain ID.
The API generates the challenge that the wallet signs. Confirm this deployed
sign-in flow end to end; a successful UI build does not verify auth configuration.

The browser connects directly to the ingestor over WSS and to the RPC over
HTTPS. Configure TLS and any required browser origin allowlists at those services.
Do not try to proxy the ingestor WebSocket through the Next HTTP route handlers.

Application routes are dynamically rendered from the mode cookie; live reads
and API responses are not shared-cacheable. Only hashed `/_next/static/*` assets
get a one-year immutable CDN/browser cache. Do not add Cloudflare "Cache
Everything" rules for HTML, RSC, `/api/*`, auth, orders or portfolio responses.
There is no R2, KV, D1, Durable Object, ISR queue or additional operational store.
Introducing ISR/revalidation later requires a new cache-consistency review.

Workers observability is enabled. Use `bunx --no-install wrangler tail` from
`apps/ui` or dashboard logs for gateway/indexer failures and runtime errors.
Request bodies, authorization headers, cookies and private keys must not be
included in log fields. Cache/proxy security headers apply to SSR and assets.

## Post-deployment acceptance

Before live testers use funds, verify the actual HTTPS domain, logo/JS/CSS,
mode switching, wallet network selection, sign-in, market reads, order submission
and cancellation, and live probability updates using the intended deployed
services. Check `API_URL` / `INDEXER_URL` in the Worker and confirm the chain and
contract addresses embedded in this build. Keep the existing internal-mainnet
safety gates. This deployment setup is not a production or smart-contract audit.

## Local verification record — 2026-09-08 IST

- 65 UI tests passed, including runtime URL validation, header filtering, streamed
  order amounts, redirect rejection and same-origin mode-switching regressions.
- 21 checks passed against the generated Worker in **actual local workerd**:
  demo SSR (including market detail), live SSR with mock upstreams, immutable
  JS/CSS assets, SVG logo, private/non-cacheable HTML/API responses, order proxy,
  internal-route blocking, redirect blocking and persisted mode switching/CSRF.
- Workspace TypeScript checks and repository Biome CI passed.
- Wrangler upload dry run passed: 6,173.95 KiB script / **1,246.17 KiB gzip**,
  with 81 asset files. Local startup profile completed (13.5 ms active sampled
  time); this is not a measurement of Cloudflare's deployed cold-start latency.
- The optional deployment preflight correctly rejects absent production public settings;
  the default deployment command no longer invokes it.
  No Cloudflare deployment, production API call, wallet transaction or database
  change was made for this verification. Hosted acceptance above remains pending.

References: [OpenNext existing-app setup](https://opennext.js.org/cloudflare/get-started),
[Cloudflare OpenNext guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/),
[OpenNext environment variables](https://opennext.js.org/cloudflare/howtos/env-vars),
[OpenNext caching](https://opennext.js.org/cloudflare/caching).
