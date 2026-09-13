# Local frontends with the EC2 backend

The gitignored `apps/ui/.env.local` and `apps/admin-ui/.env.local` select
`API_URL=https://api.probabl.trade` and `INDEXER_URL=https://api.probabl.trade`.
The public UI also uses `NEXT_PUBLIC_POLYMARKET_STREAM_URL=wss://api.probabl.trade`.
Shared backend URLs in the root `.env` remain unchanged.

Start each frontend in its own terminal from the repository root. Load both files
in this order: the root file supplies mainnet addresses, and the app file overrides
only its service targets. A plain root-level Bun command inherits the root URLs instead.

```bash
bun --env-file=.env --env-file=apps/ui/.env.local run dev:ui
bun --env-file=.env --env-file=apps/admin-ui/.env.local run dev:admin-ui
```

- UI: http://localhost:3001
- Admin UI: http://localhost:3002

These frontends use real mainnet data and wallet transactions, not demo balances.
Changing a frontend target neither deploys the backend nor grants contract roles.

Private indexer/ingestor/reconciler health routes are not exposed through nginx.
In the local admin override, empty `INDEXER_HEALTH_ORIGIN`, `POLYMARKET_INGESTOR_URL`
and `RECONCILIATION_URL` disable these inaccessible probes; their dashboard state is
`unknown`, not a fabricated healthy/offline result. API `/ready` remains checked publicly.
Inspect private service health and database connectivity over SSH.

## Read-only checkpoint: 2026-09-10, approximately 13:35 UTC

- Both local frontend market proxies returned HTTP 200 with the actual empty indexed list.
- API liveness: HTTP 200. API readiness, private indexer health and reconciler health: HTTP 503.
- Indexer advanced from block 58,206,607 to 58,207,361 during inspection. A nearby RPC
  sample was at 59,442,404: approximately 1.24 million blocks / 35 hours of lag.
- Aurora writer connectivity passed certificate verification and TLS 1.3. PostgreSQL 18.4;
  database size about 27.6 MB; seven database sessions, no blocked sessions or deadlocks observed.
  These were read-only runtime-user checks, not a database load test or full performance audit.
- The bounded block ring retained 8,192 entries in both samples; no database state was deleted.
- All four backend PM2 processes were online with zero restarts in their current lifecycle.
  Polymarket liveness passed, but no subscribed-market price feed was validated.
- EC2 checkout remained `243d690`; its legacy admin operator list was empty and the newer
  single-MARKET_ADMIN API workflow was not deployed. No remote services/configuration were changed.

Backfill/freshness and a successful reconciliation must recover before trading readiness can pass.
Deploy the reviewed single-admin API changes separately, and grant the existing resolution role
as described in [single-market-admin.md](single-market-admin.md) before using final resolution.
