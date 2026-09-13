# Milestone 12 — Polymarket data and admin evidence workflow

## Goal

Integrate Polymarket for display-only event metadata/probability and provide a rigorous human-admin evidence workflow for manual local resolution, without any automated settlement connection.

## Implementation status (2026-09-05)

Implemented in `packages/market-data`, `services/polymarket-ingestor`, and the admin-evidence portion
of `apps/api`. Architecture and operating details are recorded in
`docs/architecture/polymarket-data-admin-evidence-v1.md`,
`docs/api/v1-market-data-admin-evidence.md`, and `docs/runbooks/polymarket-data.md`.

The implementation follows the official Gamma market, CLOB book, and market WebSocket schemas.
Because ordinary market messages do not provide a universally documented monotonic sequence, the
adapter uses optional sequence values when present and always treats REST as the recovery authority.
The ingestor has no contract, signer, or transaction dependencies.

## Dependencies

- Milestone 04 immutable market mapping.
- Milestone 08 manual resolution controller.
- Milestone 10 indexer/data foundation.

## Metadata ingestion

Use current official discovery APIs to collect:

- event/market identifiers and condition ID;
- outcome labels and token IDs/index mapping;
- question and rules text;
- end time and active/closed state;
- canonical URL/slug;
- available resolution metadata;
- raw payload, fetch timestamp, and canonicalized payload hash.

Metadata may prefill an admin draft only. It must not call `createMarket`, approve a mapping, schedule a market, or modify immutable terms.

## Probability ingestion

- Bootstrap from the official REST order-book endpoint.
- Maintain the external YES book using the official market WebSocket.
- Recover dropped connections/sequence gaps with a fresh snapshot.
- Periodically reconcile the local book representation with REST.
- Derive best YES bid/ask, midpoint, spread, standard-notional depth, timestamp, and stale/quality flags.
- Store raw snapshots and normalized ticks for time-weighted historical charts.
- Do not fabricate a probability for one-sided, crossed, stale, or insufficient-depth books.

Probability is informational only. It cannot move funds, create markets, freeze markets by itself unless an explicitly configured operational rule says to mark/freeze, or resolve a market.

## Admin market evidence

For manual creation, produce a review record containing:

- selected stock and quote token;
- exact condition ID and YES/NO orientation;
- rules snapshot/hash and dates;
- source URLs and raw metadata hash;
- preparer/reviewer identifiers and timestamps;
- approved market-creation transaction payload.

The actual creation remains a manual market-admin multisig action.

## Admin resolution evidence

Provide workflow support for:

1. selecting only a frozen/awaiting-resolution local market;
2. displaying the immutable mapped condition and outcome orientation prominently;
3. attaching official Polymarket status/URL plus Polygon address, transaction, block, screenshots, or exports when available;
4. entering one allowed payout vector;
5. hashing a canonical resolution packet;
6. independent second-person review;
7. generating and simulating the `resolveMarket` multisig transaction;
8. reconciling the final onchain event with the approved packet.

The service must not poll for a resolved status and automatically generate, sign, queue, or submit a resolution transaction. Human review and admin multisig execution are mandatory.

## Data model

Implementation update (2026-09-07): the original table sketch below is superseded by the
[database audit](../audit/2026-09-07/database-optimization/REPORT.md). Use canonical evidence tables,
metadata snapshots and latest-tick/head caches, without redundant evidence mirrors or raw book history.

- `polymarket_probability_ticks`;
- `polymarket_raw_snapshots`;
- `market_creation_evidence`;
- `resolution_evidence_packets`;
- `resolution_admin_reviews`;
- `resolution_admin_transactions`;
- append-only attachment metadata and content hashes.

## Failure behavior

- API/WebSocket outage: mark display data stale; local trading may continue according to market policy.
- Metadata changes: alert, preserve old raw payload, and never rewrite an existing market mapping.
- Market closes/enters resolution unexpectedly: notify operations for a manual/guardian freeze decision under the lifecycle rules.
- Conflicting outcome evidence: block the admin workflow and escalate.
- Polymarket never resolves: remain awaiting resolution indefinitely.

## Tests

- Snapshot/WebSocket startup, update, gap, duplicate, disconnect, and recovery.
- One-sided, crossed, empty, stale, and low-depth probability display states.
- Exact YES/NO orientation for representative markets.
- Creation/resolution packet canonicalization and stable hashing.
- Separation-of-duties checks for preparer and reviewer.
- Transaction preview mismatch and wrong-network rejection.
- Automated test proving ingested resolution-like data cannot call the controller.
- Tampered attachment/packet evidence hash detection.

## Deliverables

- `services/polymarket-ingestor` and `packages/market-data` adapter.
- Probability and quality APIs/WebSocket topics.
- Creation and resolution evidence schemas/workflows.
- Append-only evidence storage integration.
- Data-staleness and mapping-change alerts.

## Exit criteria

- [x] Display probability survives disconnect/reconciliation tests and carries quality/timestamp metadata.
- [x] Market mappings are manually reviewed and immutable after creation.
- [x] Two different admins must prepare and approve resolution evidence.
- [x] The multisig transaction matches the reviewed evidence hash and vector exactly.
- [x] No ingestion event can create or resolve a market automatically.
- [x] No Polygon watcher, attestation service, bridge, or proof verifier exists.

## Verification evidence

- `bun test packages/market-data services/polymarket-ingestor apps/api/src`
- `bun run check` — 72 TypeScript tests and 57 Solidity tests passed, with Biome, Forge lint/format,
  and all workspace type checks clean on 2026-09-05.
- `bun run e2e:milestone12:anvil` against a fresh Anvil deployment, Ponder, ingestor, and API
- The E2E fixture emits `market_resolved` and asserts the local registry remains `Scheduled` until
  explicit market-admin and resolution-admin transactions are executed.

## Non-goals

- Trading Polymarket positions.
- Bridging Polymarket ERC-1155 tokens.
- Automatically interpreting or submitting resolution.
- Commercial redistribution beyond confirmed data rights.
