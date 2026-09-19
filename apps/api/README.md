# Solana API

`src/solana.ts` is the process entrypoint. `src/solana/server.ts` composes the
Hono application and owns startup/shutdown; feature code lives next to its
routes under `auth/`, `admin/`, `chain/`, `custody/`, `health/`, `market-data/`,
and `trading/`. External clients are in `src/integrations/`; shared HTTP
concerns are in `src/common/`. Tests mirror those domains under `test/`.

All database schema, SQL, and queries belong to `packages/db`. API routes use
the indexed Solana snapshot for ordinary reads and invoke live RPC only when a
transaction or governance action requires it.

Run `bun run --filter @conditional-stocks/api typecheck`, `build`, and `test`
from the repository root. Validator/database end-to-end tests live in
`scripts/solana/test-application.ts`.
