# Solana devnet on EC2

Dedicated host: `ubuntu@ec2-57-183-26-209.ap-northeast-1.compute.amazonaws.com`.
Checkout: `/home/ubuntu/probabl-solana`. HTTPS origin: `https://api-solana.probabl.trade`.
Cloudflare DNS-only A record: `api-solana.probabl.trade` → `57.183.26.209`, TTL 300.
This directory owns the Solana deployment. Shared logging and systemd assets
remain in the parent `ops/ec2/` directory.

## Services

| PM2 process              | Loopback port | Responsibility                                                                  |
| ------------------------ | ------------- | ------------------------------------------------------------------------------- |
| `probabl-sol-api`        | 3000          | Wallet auth, order planning, unsigned transactions, governance evidence         |
| `probabl-sol-indexer`    | 42069         | Finalized account/history indexing, orderbook projections, vault reconciliation |
| `probabl-sol-polymarket` | 42073         | Reference metadata and probability ingestion, authenticated internal API        |

All three run as `ubuntu`, using Bun in single-instance PM2 fork mode. Redis runs
as a private system service for the API's 60-second probability cache; see
[probability caching](../../../docs/runbooks/probability-cache.md). No matching
daemon, settlement relayer, frontend, or wallet signer is needed.
The API and indexer share the public HTTPS origin: Nginx routes `/v1/*`
to the API and explicit read-only projection paths to the indexer. Public health
paths are `/health`, `/ready`, `/indexer-health`, `/polymarket-health`.
Internal endpoints and arbitrary files are not exposed. Backend ports bind only
to `127.0.0.1`; allow SSH plus TCP 80/443 ingress. Port 80 must stay reachable
for certificate renewal; other HTTP requests redirect to the fixed HTTPS hostname.

Display-only Jupiter spot pricing runs within the API. See
[spot pricing](../../../docs/runbooks/spot-prices.md) for its API-only credentials,
mainnet timestamp RPC, devnet mint aliases and existing-installation update steps.

## Initial provisioning

1. Clone the intended release into the exact checkout path above. Check that no
   other services or databases use the target schemas before provisioning.
2. Run `bash ops/ec2/bootstrap.sh` on EC2. It installs official checksum-verified
   Node 24 LTS, pinned Bun 1.3.14, PM2, Nginx, and logging utilities. Run
   `bun install --frozen-lockfile` in the checkout; there is no contract redeploy
   or frontend build on this backend server.
3. On the operator machine, run `bun ops/ec2/solana/stage-env.ts`. It reads
   `.env.devnet` and `.local/devnet/backend.env` privately and stages new random
   per-service DB credentials in `.local/ec2/env/` (directory 0700, files 0600).
   It refuses to overwrite existing staged credentials. Never copy the entire
   `.env.devnet`, a wallet key, or the deployment keypair/state directory.
4. Securely transfer only the four staged `*.env` files to the corresponding
   private EC2 directory and the public `certs/rds-ap-northeast-1-bundle.pem` CA
   bundle to the checkout. The script rewrites `sslrootcert` to the EC2 path.
5. On EC2, run the read-only diagnostic:

   ```sh
   bun --env-file=.local/ec2/env/bootstrap.env packages/db/scripts/verify-connection.ts
   ```

6. Run `bun ops/ec2/solana/provision-db.ts` once. It checks the deployment identity
   **before** migration, rejects conflicting schemas/roles, applies checked-in
   migrations, and creates restricted `probabl_sol_api`, `probabl_sol_indexer`,
   and `probabl_sol_polymarket` logins. API/indexer own only `solana_api` and
   `solana_indexer` respectively. The reference service receives narrowly scoped
   DML privileges, not a database administrator or migration login. Remove the
   temporary `.local/ec2/env/bootstrap.env` from EC2 after success; do not delete
   or regenerate the three runtime credential files.
7. Configure the DNS record using the operator-side command in the HTTPS section
   below. On a **new host**, run `bash ops/ec2/solana/setup-https.sh --issue-only`
   to issue the certificate before starting the HTTPS ingress. Then run
   `bash ops/ec2/solana/setup-supervision.sh`. On this dedicated host it
   installs log limits, systemd persistence, three PM2 apps, and HTTPS Nginx.
   The default Nginx site link and original Nginx logrotate config are preserved
   under `/etc/probabl-sol-backups/`. `nginx -t` must pass before reload.
8. Verify:

   ```sh
   bun ops/ec2/solana/verify-runtime.ts
   bun ops/ec2/solana/http-smoke.ts https://api-solana.probabl.trade
   bun ops/ec2/solana/http-smoke.ts https://api-solana.probabl.trade --auth
   ```

   `--auth` creates an expiring DB session for a new, unfunded ephemeral wallet;
   it checks challenge signing, replay rejection, origin restrictions and admin
   denial. No on-chain transaction is signed or submitted.

## Operation and updates

```sh
cd /home/ubuntu/probabl-solana
pm2 status
bun ops/ec2/solana/inspect-logs.ts
curl -fsS --resolve api-solana.probabl.trade:443:127.0.0.1 https://api-solana.probabl.trade/ready
curl -fsS http://127.0.0.1:42069/reconciliation
```

After reviewing/pulling a release, run `bun install --frozen-lockfile`, apply
any explicitly required migrations with temporary administrator access, then
`pm2 startOrRestart ops/ec2/solana/ecosystem.config.cjs` and `pm2 save`.
Re-run the smoke checks. Do not run `solana:dev` against this shared RDS database.

`pm2-ubuntu` and Nginx are enabled at boot. The PM2 systemd cgroup has a 1200 MiB
memory-high threshold and 1500 MiB maximum on this 2 GiB host. Each application
also has a PM2 restart threshold (384/384/256 MiB for API/indexer/reference).
Core dumps are disabled and the PM2 service umask is 0077.

PM2 logs: rotate at **10 MB**, retain **7** compressed archives per log, check
every **10 seconds**, and rotate daily at midnight UTC. The checked-in one-line
pm2-logrotate 3.0.0 boolean compatibility patch makes `compress=true` effective.
The module also rotates PM2's own daemon logs. Nginx has 10 MB/daily rotation,
7 retained archives and compression, checked by logrotate every 5 minutes.
These are periodic thresholds, not hard byte caps between checks. Journald is
bounded to 200 MB persistent / 50 MB runtime, with 7-day retention.

## Local UI

Keep the existing Solana deployment values from `.local/devnet/ui.env` and load
the local `.local/ec2/ui.env` override after it:

```sh
bun --env-file=.local/devnet/ui.env --env-file=.local/ec2/ui.env run dev:ui
bun --env-file=.local/devnet/ui.env --env-file=.local/ec2/ui.env run dev:admin-ui
```

The override sets `API_URL` and `INDEXER_URL` to `https://api-solana.probabl.trade`
and the public reference WebSocket origin to `wss://api-solana.probabl.trade`.
It contains no secrets. Restart running UI dev servers to load the new values.
Ports 3001/3002 on localhost (also 127.0.0.1) are allowed wallet sign-in origins.
The admin UI uses the public `/indexer-health` and `/polymarket-health` paths.
The separate private reconciliation probe is disabled; API `/ready` includes
reconciliation readiness. Use the server-side command above or an SSH tunnel
for detailed reconciliation output.
Do not add backend DB passwords or ingestor tokens to either UI environment.

Both UI codebases now default to the deployed HTTPS API/indexer origin, and the
trader UI defaults to the corresponding WSS stream. Explicit environment values
still override those defaults for isolated local-validator rehearsals. The
Solana wallet/RPC/genesis configuration remains separate: keep loading
`.local/devnet/ui.env` as shown above. Cloudflare Workers continue to require
explicit HTTPS `API_URL` and `INDEXER_URL` runtime bindings; the main UI's
`.dev.vars.example` supplies the deployed values for local Workers previews.

## Cloudflare DNS and Certbot HTTPS

The Cloudflare token is read **only on the operator machine** from `.env.devnet`.
It is not copied to EC2, included in the runtime environment, or committed. Only
the requested hostname is changed; other DNS records and zone-wide TLS settings
are untouched. DNS-only means TLS terminates directly at Nginx, without a
Cloudflare HTTP proxy. Keep the EC2 public IP stable (or update the A record if
the address changes).

```sh
# Operator machine: inspect first; apply refuses conflicting routing records.
bun ops/ec2/solana/cloudflare-dns.ts inspect
bun ops/ec2/solana/cloudflare-dns.ts apply

# EC2: upgrade an already-running HTTP installation.
bash ops/ec2/solana/setup-https.sh
# For a fresh host instead, use --issue-only before setup-supervision.sh.

# Test renewal AND the deploy/reload hook, without replacing the live certificate.
sudo certbot renew --cert-name api-solana.probabl.trade --dry-run --run-deploy-hooks --non-interactive --no-random-sleep-on-renew
systemctl status certbot.timer --no-pager
sudo certbot certificates
```

Certbot 4.0.0 is installed from Ubuntu's package repository. HTTP-01 uses the
dedicated public webroot `/var/www/probabl-sol-acme`; Certbot's work directory
and private keys stay restricted. No DNS API credential is required for renewal.
The `certbot.timer` systemd timer is enabled, and the root-owned executable
`/etc/letsencrypt/renewal-hooks/deploy/probabl-sol-nginx` validates Nginx and reloads
it after successful renewal. No account email was invented or registered;
an operator can set an account contact later if desired.

Nginx serves TLS 1.2/1.3 and HTTP/2. Host-only HSTS deliberately excludes sibling
domains. HTTP redirects use status 308 with a fixed host, preserving request
methods/paths, while `/.well-known/acme-challenge/` stays available on HTTP.
Previous HTTP config is retained under `/etc/probabl-sol-backups/`.
The API's public PM2 configuration sets `EVIDENCE_PUBLIC_BASE_URL` to
`https://api-solana.probabl.trade/v1/attachments`; no HTTPS validation is bypassed.

Reference: [Cloudflare DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/),
[Certbot webroot and renewal documentation](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot).

## Deployment: 2026-09-25 (fresh program)

Application checkout `54dab50` (plus operator-side follow-ups). The previous
program `8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg` was closed (its rent
returned to the deployer); its accounts are unusable. Fresh identity:

```text
genesis: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
program: 53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra
config:  EfXom6mQxuw5gsHG4AujCgo1dQ3qWg5pN85RvY1ysn23
frozen deployment lookup table: BJMmm3pT6CX3hQ1xK7sbrEQGf3xtpDvf4GpY52fB6EPs
lookup keeper: 7PierXUPrUrskC5hi9j6ZmHmYNtCZzaAtGpN2vfi9iFJ (inside the indexer)
```

The database was reset with `reset-devnet.ts`, then migrated. Env changes were
applied with `update-deployment.ts`, which now reads per-service settings as
JSON on stdin (allowlisted names only; credentials are retained):

```bash
echo '{"indexer":{"YELLOWSTONE_GRPC_URL":"…","YELLOWSTONE_X_TOKEN":"…"}}' \
  | bun ops/ec2/solana/update-deployment.ts --execute
```

The indexer streams from Alchemy's devnet Yellowstone endpoint with
`YELLOWSTONE_COMPRESSION=none` (Alchemy rejects compressed requests) and relays
events to the API on `127.0.0.1:42070`. The lookup-table keeper runs inside the
indexer (`SOLANA_LOOKUP_KEEPER_KEYPAIR`, a server-only key in `.local/ec2/`);
the market-maker wallet is pre-registered via `SOLANA_LOOKUP_KEEPER_OWNERS`.
The API needs at least one frozen deployment table; create one before any
market exists with `LOOKUP_TABLE_MINTS` (quote and issuer mints) in
`scripts/solana/create-lookup-table.ts`.

## Deployment verification: 2026-09-19

Application checkout: `22b5d98`, plus the new Solana deployment assets transferred
from the operator checkout. Ubuntu 26.04 x86_64; Node 24.21.0; Bun 1.3.14;
PM2 7.0.4; pm2-logrotate 3.0.0; Nginx 1.28.3. RDS PostgreSQL 18.4, writer endpoint,
certificate-verified TLS 1.3, with the application namespace tied to:

```text
genesis: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
program: 8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg
config:  6buYkVtSJjaoozCDsPFYrPhp5g1q1oLg2eLp7FpsZ1tF
```

Public health/readiness, native projection routes, private-route denial and
ephemeral-wallet sign-in passed. The controlled systemd/PM2 restart restored
the saved process list. No deployer private key was sent to EC2 and no Solana
transaction was submitted by this backend deployment.

There are currently **no markets or reference subscriptions**. Empty market and
order lists are expected; this is not a completed trading lifecycle test.
Before realistic trading, create/list a test market and fund the testing wallets.
The existing validator-dependent API lifecycle test was not run against devnet.

HTTPS was activated on 2026-09-13 with a Let's Encrypt ECDSA certificate for
`api-solana.probabl.trade`, initially expiring **2026-12-12 06:50:27 UTC**.
The staging renewal dry run, including Nginx's deploy hook, passed. The initial
HTTP deployment was upgraded without restarting the indexer or reference service;
only the API restarted to load its HTTPS attachment base URL.

This is still a devnet deployment, not approval for production use.
The public Solana devnet RPC is rate-limited; configure a suitable
private/archival RPC if load or retention requires it, without bypassing the
indexer's fail-closed history/readiness checks.

## Fresh program cutover

The fresh-deployment cutover is intentionally fail-closed. Stop every runtime
before resetting storage, switch the reviewed public program identifiers without
touching provider/database credentials, migrate all three isolated schemas, grant
the API read-only access to the indexer's published snapshot, and only then start
the supervised services:

```bash
cd /home/ubuntu/probabl-solana
pm2 stop probabl-sol-api probabl-sol-indexer probabl-sol-polymarket
bun ops/ec2/solana/update-deployment.ts --execute
bun --env-file=.local/ec2/env/api.env packages/db/scripts/migrate-solana.ts
bun --env-file=.local/ec2/env/indexer.env packages/db/scripts/migrate-solana.ts
bun --env-file=.local/ec2/env/polymarket.env packages/db/scripts/migrate-polymarket.ts
bun ops/ec2/solana/grant-indexed-reads.ts
pm2 startOrRestart ops/ec2/solana/ecosystem.config.cjs --update-env
pm2 save
```

The destructive schema reset is performed separately with the guarded
`packages/db/scripts/reset-devnet.ts --execute` command and an administrator
connection. It refuses every host, database, user, and TLS mode except the
reviewed Devnet RDS target.
