# Demo mode retired from production apps

`apps/ui` and `apps/admin-ui` use real APIs, indexed state and wallet transactions only.
The demo provider, simulation engine, seeded markets, fake wallet and simulated resolution
controls have been removed. Existing `probabl-mode=demo` cookies and old per-tab demo ledgers
are not read; the retired `POST /api/mode` endpoint returns 410 and expires the cookie.

The standalone showcase remains on `codex/demo-ui-v2-redesign`, separate from the production app.
Synthetic fixtures under test directories are used only for isolated verification, never as
application fallbacks. Missing or failed upstream data must remain empty or explicitly unavailable.

Market creation and resolution are admin-only; see [single-market-admin setup](single-market-admin.md).
