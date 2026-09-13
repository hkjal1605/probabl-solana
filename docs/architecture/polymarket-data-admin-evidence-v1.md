# Polymarket data and admin evidence v1

## Authority boundary

Polymarket is an external display-data and human-evidence source. It is never a settlement oracle for
the Robinhood Chain contracts.

```text
Gamma metadata ----> append-only snapshot ----> admin creation packet ----> two-person review
                                                                      ----> market-admin multisig

CLOB REST ----> authoritative YES-book snapshot ----> normalized probability tick ----> public API
Market WS ----> incremental YES-book changes --------^          |
market_resolved event ----> alert with raw evidence only -------+----> no contract dependency

final human evidence ----> resolution packet ----> second admin ----> market-admin beginResolution
                                                               ----> resolution-admin resolveMarket
                                                               ----> Ponder reconciliation
```

The ingestor has no chain client, protocol ABI, signer, market-creation callback, resolution callback,
or transaction queue. A source event can only append source data, update an informational probability,
or append an operational alert. Market creation and resolution require authenticated human operators
and exact external multisig execution.

The external adapter contract is based on Polymarket's official documentation for the
[Gamma market response](https://docs.polymarket.com/api-reference/markets/get-market-by-id),
[CLOB order-book snapshot](https://docs.polymarket.com/api-reference/market-data/get-order-book),
[market WebSocket](https://docs.polymarket.com/api-reference/wss/market), and
[resolution process](https://docs.polymarket.com/concepts/resolution). Changes to those upstream
schemas require fixture updates and an explicit adapter review; permissive fallback parsing is not
allowed for identity or outcome fields.

## Immutable mapping

`packages/market-data` accepts only a non-negative-risk binary market containing exactly one `YES`
and one `NO`. Gamma `outcomes` and `clobTokenIds` are paired by array position. Index set `1` belongs
to array element zero and index set `2` to element one; label ordering is never assumed. The normalized
mapping binds:

- the Polygon condition ID;
- each normalized label to its exact token ID and index set;
- the Gamma market ID and canonical event URL; and
- a deterministic `mappingHash`.

After an approved creation transaction is indexed, the API compares every mapped onchain field with
the approved packet before instructing the ingestor to track the YES token. Later metadata changes are
stored and alerted, but the subscription and local market mapping cannot be updated or deleted.

## Probability calculation

The ingestor bootstraps and periodically replaces its in-memory YES book from CLOB `GET /book`. It
uses market-channel `book` and `price_change` messages between snapshots. A disconnect, an older event,
or a detected sequence discontinuity causes a fresh REST reconciliation. REST is authoritative even
when its payload was seen previously.

All source prices and sizes use strict six-decimal integer parsing. `midpointX6` is returned only when
the book is connected, fresh, two-sided, uncrossed, and contains the configured quote depth on both
sides. The quality values are:

| Quality | Meaning |
| --- | --- |
| `valid` | Midpoint is usable under the configured freshness and depth policy. |
| `empty` | Neither side has a level. |
| `one-sided` | Only bids or asks exist. |
| `crossed` | Best bid is at or above best ask. |
| `low-depth` | Either side has less than the standard quote notional. |
| `stale` | The last source timestamp exceeds `POLYMARKET_STALE_AFTER_MS`. |
| `disconnected` | The market WebSocket disconnected and REST recovery has not succeeded. |

Raw metadata evidence is immutable and content-addressed. Live REST books and WebSocket deltas
are applied in memory and recovered from REST; they are not archived without a replay/UI consumer.
PostgreSQL keeps only the latest normalized tick per condition, marked disconnected on restart until
REST bootstraps a live book. A separate latest-metadata pointer handles A-B-A source changes without
mutating the original evidence snapshot. This remains a single-host deployment; multi-host ingestion
requires explicit shared ownership and coordination while retaining immutable subscriptions.

## Evidence and review

Evidence packets are canonical JSON with lexicographically sorted object keys and a Keccak-256 packet
hash. Attachments are content-addressed by Keccak-256, stored as immutable PostgreSQL bytes, and verified
again at review and transaction generation. Packet, attachment links and newly inserted bytes commit
atomically. Only approved evidence attachments are served by the API download route.

A creation packet contains the exact mapping, source snapshot/hash, rules/hash, metadata URI/hash,
stock/quote addresses, dates, risk parameters, sources, attachments, preparer, and timestamp. A
resolution packet additionally binds the immutable local mapping, Polygon chain ID `137`, Conditional
Tokens address, available Polygon transaction/block references, final-status observations, one allowed
payout, and a durable `sourceReference`.

Allowed payout vectors are YES `[1,0]/1`, NO `[0,1]/1`, and invalid `[1,1]/2`. Conflicting active
packets or conflicting observations are rejected. Approval requires all packet-specific checklist
items and a reviewer wallet different from the preparer.

The API only produces simulated transaction objects. It never holds a market or resolution admin key
and never broadcasts these actions. Before signing, operators compare the proposed Safe transaction
byte-for-byte with the stored preview. After execution, reconciliation requires a successful indexed
transaction and exact canonical fields. Resolution retains the packet hash as the final `evidenceHash`.
The `beginResolution` reason hash is the domain-separated commitment from
`ManualResolutionController.hashResolution`, binding the chain, controller, market, payout,
denominator, evidence hash, and exact URI bytes. Reconciliation checks this commitment; the final
event must match the complete approved call.

## Persistence tables

The ingestor owns metadata-only `polymarket_raw_snapshots`, `polymarket_metadata_heads`,
`polymarket_latest_ticks`, immutable `polymarket_subscriptions`, and `polymarket_alerts`.
The API evidence store owns canonical packet, review, preview, observation and admin-action tables.
Attachment references/hashes are in the canonical packet; the verified attachment bytes are stored
separately. Redundant milestone mirrors and attachment-metadata copies are no longer written.
Triggers still prevent mutation/deletion of canonical evidence, metadata, subscriptions and alerts;
latest pointers/ticks are intentionally mutable derived caches. Existing historical archives are
preserved, not silently deleted by a service upgrade.

## Deliberate exclusions

There is no Polygon watcher, CTF proof verifier, bridge, cross-chain message, attestation signer,
automatic freeze, automatic transaction generation from a resolution event, or automatic market
creation/resolution. A displayed probability is informational and cannot affect custody or payout.
