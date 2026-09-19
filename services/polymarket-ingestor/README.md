# Polymarket ingestor

Display-only Gamma metadata and CLOB YES-book ingestion for Probabl on Solana. The service stores
append-only raw payloads and normalized probability ticks, maintains immutable reviewed
subscriptions, and emits operational alerts. It deliberately contains no chain client or admin
transaction path.

Run with `bun run dev:polymarket`; configuration is listed in `.env.example`.
It initializes its own `operations.polymarket_*` tables through `packages/db`.
These tables are source-data storage, independent of a chain deployment.
