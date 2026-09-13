# Polymarket data and evidence runbook

## Start locally

First configure an isolated local PostgreSQL `DATABASE_URL` as described in [shared PostgreSQL](shared-postgres.md). The normal Anvil sequence is:

```bash
bun run anvil:indexer
bun run anvil:indexer:bootstrap
bun run dev:indexer:anvil
POLYMARKET_GAMMA_URL=http://127.0.0.1:42100 \
POLYMARKET_CLOB_URL=http://127.0.0.1:42100 \
POLYMARKET_WS_URL=ws://127.0.0.1:42100/ws \
bun run dev:polymarket:anvil
bun run dev:api:anvil
bun run e2e:milestone12:anvil
```

The E2E harness starts a local Gamma/CLOB/WebSocket fixture on port `42100`, creates and reviews a
market packet using one MARKET_ADMIN wallet session, executes the explicit admin transactions, verifies that a
resolution-looking WebSocket event cannot change the local market, and reconciles the final Ponder
projection. The ingestor may start before the fixture because it has no subscription until the
approved creation transaction is reconciled.

The API uses one configured MARKET_ADMIN wallet. Its onchain address needs the market-admin
and resolution-admin roles; governance and guardian roles remain separate. Anvil uses account 2
for both market roles and verifies account 5 cannot use the admin API.

## Required controls

- Set a unique, high-entropy `POLYMARKET_INTERNAL_TOKEN`; expose the ingestor only on a private
  service network.
- Set `MARKET_ADMIN` to the wallet that manages market creation, approval and resolution.
- Explicit evidence approval is mandatory, but a second reviewer is no longer required.
- See [role grants and security tradeoff](single-market-admin.md).
- Point `ADMIN_EVIDENCE_PUBLIC_BASE_URL` at the HTTPS API `/v1/attachments` route. Reviewed attachment bytes are read from PostgreSQL; no local file mount is used.
- Back up the shared PostgreSQL database, Safe records and published IPFS/source documents. Test restoration and hash verification.
- Confirm commercial data-display/storage rights before production.

## Daily checks and alerts

Monitor latest source timestamp, tick quality, WebSocket disconnects, REST failures, mapping changes,
unexpected closure/resolution status, evidence awaiting review, Safe transaction age, Ponder lag, and
unreconciled admin transactions. `GET /internal/alerts` returns the most recent ingestor alerts.

`METADATA_MAPPING_CHANGED` is a stop condition for drafting or resolution. Compare the old and new
raw snapshots and the immutable onchain mapping. Never edit the subscription or local market.

`RESOLUTION_EVENT_REQUIRES_HUMAN_REVIEW` and `MANUAL_LIFECYCLE_REVIEW_REQUIRED` are notifications,
not commands. An authorized operator decides whether to propose a manual freeze under the market
lifecycle policy. No service should translate them into a chain transaction.

## Incident handling

- **WebSocket disconnect:** the service publishes `disconnected`, reconciles with REST, then
  reconnects with exponential backoff capped at 30 seconds. If REST also fails, keep probability
  unavailable/stale and leave protocol state unchanged.
- **Sequence/ordering gap:** expect `WEBSOCKET_GAP` followed by a full REST replacement. Investigate
  repeated gaps and compare stored raw payloads.
- **One-sided/crossed/low-depth/stale:** show the quality state and no midpoint. Do not derive the
  missing value from local conditional prices or last trade.
- **Mapping mismatch:** block creation/resolution preparation. Preserve all snapshots and escalate;
  never remap a filled market.
- **Conflicting resolution evidence:** leave the market frozen/awaiting indefinitely until humans
  resolve the discrepancy. Rejecting a packet creates an append-only review; do not mutate it.
- **Missing/tampered attachment:** stop review and signing, restore the exact content-addressed byte
  object from verified backup, and re-run integrity checks. Never replace bytes under the same URI.
- **Source never finalizes or remains disputed:** do not resolve locally. There is no timeout outcome.
- **Suspected operator/session compromise:** revoke API access, preserve audit records, and rotate
  sessions. The API cannot broadcast, but inspect all Safe proposals and halt signing.

## Safe execution checklist

For every admin transaction, retrieve the approved packet, independently verify the packet and
attachments, generate a fresh simulated transaction, call `verify-transaction` with the Safe
proposal, and compare chain ID/from/to/value/calldata. Execute only through the correct Safe. After
the configured indexer confirmations, call `reconcile`; a mismatch is an incident, not a field to
override.

For resolution, reconcile `begin-resolution` before generating `resolve-market`. Confirm the packet
commitment (not the bare packet hash) matches the registry reason hash, then confirm `ResolutionFinalized` contains the identical
hash, payout vector, and source URI.
