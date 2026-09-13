# Raw-unit ratio pricing — protocol v2

This supersedes v1 price/unit assumptions. It is a breaking change requiring fresh contracts,
new market IDs, fresh databases and newly signed orders. It does not approve production launch.

## Settlement units

Every amount onchain is an integer count of the token's native units. CTF positions inherit
their collateral's raw units. Contracts neither call `decimals()` nor normalize balances.

`limitPriceRawX18` and `priceTickRawX18` are raw quote units per raw base unit, multiplied by
`1e18`. Execution uses `floor(quantityRaw * priceRawX18 / 1e18)`; bid reservations and open-notional
caps use the ceiling. Ask escrow is raw base quantity. Minimum notional and all notional caps
are raw quote amounts. Quantity and price fields are positive uint128 values.

For stock18/USDG6, one stock (`1000000000000000000`) at 200 USDG has
`limitPriceRawX18 = 200000000` and settles `200000000` raw USDG units. The fixed denominator
is ratio precision, not an assumption that either token has 18 decimals.

Whole-token price conversion belongs at the input/display boundary:

`priceRawX18 = humanQuotePerBase * 10^(18 + quoteDecimals - baseDecimals)`.

The shared domain unit helpers use BigInt and exact decimal strings. Unrepresentable prices,
quantity precision loss, malformed numbers and uint128 overflow are rejected, never rounded into
a different signed order. Stock18/USDG6 permits six human price decimal places; market ticks can
be coarser. No floating-point value enters settlement, signing, reservations or price-level keys.
UI numeric approximations are for visual formatting only; default order prices use exact strings.

## Metadata and issuer behavior

The indexer reads actual token decimals at the MarketCreated block and stores them alongside raw
amounts, `protocolVersion: 2` and `priceFormat: "raw-unit-ratio-x18"`. The API checks those units
against confirmed-block RPC reads. Reconciliation detects changed decimal metadata. Unsupported
or missing metadata fails closed; there is no default of 18. The display layer supports decimals
0 through 36; the raw settlement math itself has no metadata restriction.

Robinhood `uiMultiplier` is not a rebase of raw ERC-20 balances. It is not applied to order
quantities, CTF collateral, escrow or settlement. Prices here are per whole *raw Stock Token*,
not an automatic promise of a constant number of underlying shares after a corporate action.
Issuer pauses, blocklists, upgrades, scheduled multipliers and chain-level policy still require
separate review and monitoring. Boolean-returning exact transfers remain required by pinned CTF.

## Version and migration boundary

- Registry protocol version and market/question IDs are v2. The subsequent [fee extension](./trading-fees.md) uses EIP-712 Order domain version `3` and signs `maxFeeBps`, without changing these raw-unit definitions.
- Signed/event fields are `limitPriceRawX18`, `executionPriceRawX18`, `priceTickRawX18`;
  IOC protection is `worstPriceRawX18`.
- Gateway and indexer market payloads use raw-unit v2 semantics. Order signing is v3 (fee caps); execution uses the [atomic v1 router](./atomic-placement.md), with no matcher checkpoints/proposals or settlement worker.
  Creation evidence is v2; the unchanged binary resolution commitment construction remains v1.
- Services require the shared PostgreSQL database and reject legacy local-store configuration. Old
  signatures, calldata and persisted orders must not be relabeled or numerically converted.
- Preserve the old deployment, database and audit evidence. Cancel/recover old escrow using
  the old deployment's verified tools. Never erase or rewrite the historical state.
- Deploy a fresh verified v2 graph; accept the delayed admin handover; curate new markets using
  raw-unit caps; initialize one shared PostgreSQL database and a fresh indexer projection; replay only v2 logs.
- CLI tick input is `PRICE_TICK_RAW_X18`; generated deployment manifests are `v2-<authority>.json`.
  The legacy `deploy:v1` script alias currently invokes the same v2 deployer; prefer `deploy:v2`.
- HTTP route prefix `/v1` and v2 raw-unit payloads are retained; order signing is v3 after the fee extension. It does not
  imply payload compatibility. Legacy price field names are not accepted.

Validate exact real-token fork lifecycles, clean indexer rebuild, deep reconciliation, funding
matrix, partial fills, IOC/refunds, cancellation and all three payouts before accepting this
migration. Anvil compatibility is not Nitro/sequencer certification. M-02 specialist clearance,
independent security review and production operational gates remain mandatory.
