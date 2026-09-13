# Polymarket ingestor

Display-only Gamma metadata and CLOB YES-book ingestion for Conditional Stocks v1. The service stores
append-only raw payloads and normalized probability ticks, maintains immutable reviewed
subscriptions, and emits operational alerts. It deliberately contains no chain client or admin
transaction path.

Run with `bun run dev:polymarket`; configuration is listed in the repository `.env.example`.
Architecture, API, and operations details are in:

- `docs/architecture/polymarket-data-admin-evidence-v1.md`
- `docs/api/v1-market-data-admin-evidence.md`
- `docs/runbooks/polymarket-data.md`
