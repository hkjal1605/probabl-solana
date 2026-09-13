# EC2 backend deployment

**Current checkpoint (2026-09-10):** the fresh contracts, database reset and backend rollout
are recorded in [the redeployment report](redeployment-2026-09-10.md). The sections below
describe the original host setup unless updated explicitly. All four services now use the
September 10 graph, the single-MARKET_ADMIN API is enabled, and Alchemy replaces the public
backend RPC. RPC throttling still blocks catch-up and trading readiness; do not treat
process liveness or successful HTTP smoke checks as a passing readiness gate.

This is the owner's explicitly acknowledged **internal mainnet testing** deployment,
not public-production approval. Both frontends remain off EC2. HTTPS and API DNS
were added on 2026-09-09 at the owner's request. New markets, resolutions,
contract transactions and administrator handover are not performed by these scripts.

## Host and checkout

- EC2: `i-03c5d2c6e2fc20b3b`, `probabl-server`, Tokyo, `c6a.large` (2 vCPU, 4 GiB).
- SSH: `ubuntu@13.231.158.201`; local key: `probabl-server-keypair.pem` (gitignored).
- Ubuntu 26.04; checkout: `/home/ubuntu/probabl`, owned by `ubuntu`.
- Git remote: `git@github.com:hkjal1605/probabl.git` using the existing server deploy key.
- Base commit: `243d690545c397a04117de79193dadde7cd471f6`.
- Node `24.20.0`, Bun `1.3.14`, PM2 `7.0.4`, pm2-logrotate `3.0.0`.
- Dependencies installed using the committed `bun.lock` and `--frozen-lockfile`.

`ops/ec2/` and the database diagnostic/provisioning scripts were added locally and
copied to the server on top of that Git commit. They have **not** been committed or
pushed by the deployment. Commit/review them before relying on a future Git-only
deployment. Do not overwrite a dirty checkout with `git reset` or a forced pull.

The scripts are scoped to this Ubuntu host. `bootstrap.sh` installs the runtime;
`setup-supervision.sh` installs system configuration and restarts the PM2 daemon.
The latter is an initial-setup/maintenance operation, not a zero-downtime redeploy.
Original nginx/syslog rotation settings and the disabled default-site symlink are
recoverable from `/etc/probabl-backups`.

## Services

| PM2 process | Function | Bind address | Memory restart threshold |
| --- | --- | --- | --- |
| `probabl-api` | Authentication, orderbook planning, user-signed recovery outbox, API | `127.0.0.1:3000` | 512 MiB |
| `probabl-indexer` | Contract preflight, Ponder projections and bounded persisted cache | `127.0.0.1:42069` | 1400 MiB |
| `probabl-reconciler` | Continuous/deep reconciliation and safety signals | `127.0.0.1:42070` | 384 MiB |
| `probabl-polymarket` | Metadata, probability feed and public WebSocket stream | `127.0.0.1:42073` | 384 MiB |

Each has one forked Bun process; there is no watcher, UI process, separate matcher,
settlement signer, Redis server, or local SQLite operational store. Ponder's
indexing cache is capped at 256 MiB and its maximum thread count is two. Its
projection and restart state remain in Aurora. No replay/start-block shortcuts
or safety bypasses were enabled.

PM2 uses exponential restart backoff, a 90-second graceful-stop deadline and a
saved process list. `pm2-ubuntu.service` is enabled at boot and has a 3 GiB memory
high threshold, a 3200 MiB hard cgroup limit, 512 tasks, 65,536 file descriptors,
disabled core dumps and a private umask. PM2's per-process thresholds are sampled
restart triggers, not instantaneous allocation limits.

```bash
cd /home/ubuntu/probabl
pm2 status
pm2 logs probabl-api --lines 50
bun --no-env-file ops/ec2/inspect-logs.ts
sudo systemctl status pm2-ubuntu nginx logrotate.timer
```

To apply reviewed code/configuration, stop or restart the named processes under a
maintenance plan, use a fast-forward-only Git update, install the frozen lockfile,
run required migrations separately, then restart through the ecosystem file:

```bash
pm2 restart ops/ec2/ecosystem.config.cjs --update-env
pm2 save
```

The environment files are loaded by each Bun process at startup. PM2's ecosystem
file/dump does not need to contain database passwords. Keep exactly the four
backend applications saved; temporary verification processes must not be saved.

## Database and secrets

All services connect to the same private Aurora writer/database:
`probabl.cluster-c3uuueq6kfve.ap-northeast-1.rds.amazonaws.com:5432/postgres`.
The verified server reports PostgreSQL 18.4. Connections use `sslmode=verify-full`
and `/home/ubuntu/probabl/global-bundle.pem`; TLS 1.3 was observed.

- `.env`: shared backend configuration plus the `probabl_api` database login.
- `.env.indexer`, `.env.reconciler`, `.env.polymarket`: each service's distinct
  `DATABASE_URL`; loaded after `.env` to override only its database credentials.
- All environment files are mode `0600`, are gitignored and contain **no wallet
  private keys** or frontend build configuration.
- Bootstrap administrator credentials were moved out of the application tree to
  `/root/.config/probabl/migration.env`, owned by root, mode `0600`.
- Locally staged deployment secrets are in `.data/deploy/env` (directory `0700`,
  files `0600`). They are gitignored; do not include them in archives or commits.

The six committed Drizzle migrations were applied before services started, and
the chain/exchange identity was verified. `packages/db/provision-roles.sql` supplies
the privilege groups. Distinct random login passwords and the role grants were
created by `packages/db/scripts/provision-runtime.ts`. Runtime users have no
Aurora superuser membership, role creation, bypass-RLS, database ownership or
migration-write privileges. Only the indexer may create its Ponder schemas.

The staging/provisioning scripts deliberately refuse to overwrite existing
credentials. Do not rerun them as a password-rotation mechanism. Coordinate a
rotation with all affected processes and use the existing privilege groups.

Read-only verification commands:

```bash
bun --env-file=.env packages/db/scripts/verify-connection.ts
bun --no-env-file packages/db/scripts/verify-runtime-permissions.ts
bun --env-file=.env --env-file=.env.indexer packages/db/scripts/inspect-indexer.ts
```

Never run test fixtures against Aurora. Database test suites require an isolated
loopback PostgreSQL instance. Never give the running API the bootstrap URL.

## HTTPS ingress

Cloudflare's DNS-only A record `api.probabl.trade` points to `13.231.158.201`
(TTL 300). Other DNS records and zone-wide SSL settings were not changed.
nginx serves HTTPS on port 443 and redirects HTTP on port 80 to the fixed HTTPS
domain using status 308, preserving request methods and bodies.

- API: `https://api.probabl.trade`; `/health` is liveness and `/ready` is trading readiness.
- Public indexer reads are allowlisted at `/markets`, `/orderbook/...`, `/orders`,
  `/trades`, `/transactions/...`, `/balances/...`, `/positions/...`, `/payouts/...`
  and `/resolutions/...`. They accept GET/HEAD only.
- Polymarket's public condition endpoints and WebSocket upgrades are proxied at
  `/v1/polymarket/conditions/...`.
- Internal routes, dotfiles, SQL/GraphQL database interfaces and metrics are not
  exposed. Internal services bind only to loopback.
- nginx applies a 5 MiB body limit, bounded timeouts, 30 requests/second per source
  IP with a 60-request burst, and 50 concurrent connections per source IP.
- Access logs omit query strings, authorization headers and request/response bodies.

```bash
bun --no-env-file ops/ec2/http-smoke.ts https://api.probabl.trade
```

The smoke script accepts a fail-closed readiness response while explicitly
reporting `tradingReady: false`; this is **not** a passing trading-readiness test.
The API auth configuration uses domain `api.probabl.trade` and origin
`https://api.probabl.trade`. Only the API was restarted for that change.
The frontends were not redeployed. Their HTTPS upstream values should be
`API_URL=https://api.probabl.trade`, `INDEXER_URL=https://api.probabl.trade` and
`NEXT_PUBLIC_POLYMARKET_STREAM_URL=wss://api.probabl.trade`. The latter is embedded
at build time. Internal backend `INDEXER_URL` must remain the loopback URL.
The current public IP should not be treated as permanent without confirming or
reserving its address separately. Cloudflare proxying is off; enabling it later
requires reviewing trusted-proxy IP handling and Full (strict) origin TLS.

### Certificate renewal

Certbot 4.0.0 and its Cloudflare DNS plugin were installed from Ubuntu packages.
The Let's Encrypt ECDSA certificate covers only `api.probabl.trade`; its initial
expiry is 2026-12-07 18:38:56 UTC. TLS 1.2 and 1.3 are enabled.

- Certificate: `/etc/letsencrypt/live/api.probabl.trade/fullchain.pem`.
- Private key: `/etc/letsencrypt/live/api.probabl.trade/privkey.pem`.
- DNS API credential: `/root/.config/certbot/cloudflare.ini`, root-owned `0600`.
  It is not in the application environment or repository. Keep the token valid
  for automatic renewal and update this file when rotating it.
- `certbot.timer` is enabled. The deploy hook
  `/etc/letsencrypt/renewal-hooks/deploy/probabl-nginx` tests and reloads nginx
  after successful renewal; its source is `ops/ec2/certbot-renew-nginx.sh`.
  A staging renewal dry-run with `--run-deploy-hooks` succeeded, including the
  nginx configuration check and reload. Public trusted HTTPS, the 308 redirect,
  protected-route smoke checks and a secure WebSocket handshake also passed.
- The ACME account was registered without an email; one can be added later.
- Previous HTTP nginx and API environment configurations are backed up root-only
  in `/etc/probabl-backups/https-2026-09-09/`.

```bash
sudo certbot certificates
sudo systemctl status certbot.timer
sudo certbot renew --cert-name api.probabl.trade --dry-run --run-deploy-hooks --no-random-sleep-on-renew
```

The nginx template now requires the certificate to exist before installation;
`setup-supervision.sh` checks this before changing any service supervision.

## Log and storage bounds

- PM2 application/module/daemon logs: 10 MiB rotation threshold, seven retained compressed
  archives per log, checked every 10 seconds, plus daily rotation in UTC.
- nginx and syslog/auth/kernel logs: 10 MiB threshold, daily rotation,
  seven archives, checked by logrotate every five minutes.
- Journald: 200 MiB persistent limit, 50 MiB runtime limit, seven-day retention,
  25 MiB files, and 1 GiB filesystem free-space reserve for journal growth.
- Application processes run with core dumps disabled.

The pinned pm2-logrotate 3.0.0 boolean parser needed a one-line compatibility patch:
its pmx dependency converts configuration strings to booleans, while the original
parser only recognized strings. `ops/ec2/pm2-logrotate.patch` makes compression
effective and is reapplied by setup after installation. PM2 logs have one rotation
owner; they are not simultaneously rotated by the OS logrotate service.

Rotation thresholds can be exceeded between checks; these settings are not a
filesystem quota or a guarantee that arbitrary future files can never fill disk.
Monitor `df -h /`, process RSS and log-directory sizes, and add external alerting
before public production. Do not delete Ponder cache or database state to recover
disk space: the maintained cache is in Aurora, not an on-disk database.

## Initial deployment readiness limitation (historical)

The public Robinhood RPC returned repeated HTTP 429 responses during historical
backfill. Ponder's adaptive throttling backed down, but observed progress was far
too slow to establish a fresh canonical head. API liveness and public market reads
work; `/ready` remains HTTP 503 and no successful deep reconciliation is claimed.
Keep the freshness, finality and reconciliation gates intact.

Supply a dedicated **Robinhood mainnet archive RPC** endpoint, update
`ROBINHOOD_RPC_URL` in the server's shared `.env`, verify it is chain 4663, then
restart the backend processes and wait for catch-up and a successful deep
reconciliation. Verify both `/ready` and `/v1/system/readiness` return HTTP 200
before testing trading. Official provider/connection guidance is in
[Robinhood's documentation](https://docs.robinhood.com/chain/connecting/), which
also identifies the public endpoint as rate-limited and unsuitable for production.

At this deployment checkpoint, `ADMIN_OPERATOR_ADDRESSES` was empty, so the optional
admin-evidence workflow was disabled. The later [single-MARKET_ADMIN workflow](single-market-admin.md)
uses `MARKET_ADMIN` instead; rolling it out also requires its evidence/ingestor configuration
and the existing onchain resolution role grant. This note does not claim that rollout occurred.
Polymarket started with no persisted subscriptions because
no markets/subscriptions have been configured. Do not interpret a successful
connectivity check as verification of live prices for a configured market.
