# V1 market terms approval

## Immutable identifiers

- Local chain ID:
- Protocol version: `1`
- Base Stock Token address and verified bytecode:
- Quote USDG address and verified bytecode:
- Polygon chain ID: `137`
- Polymarket condition ID:
- Polymarket YES index set:
- Polymarket NO index set:
- Canonical Polymarket reference:
- Rules snapshot URI:
- Rules content hash:
- Metadata URI and hash:

## Trading terms

- Trading open timestamp:
- Trading cutoff timestamp:
- Price tick X18:
- Base step:
- Minimum notional:
- Maximum order quantity/notional:
- Maximum wallet open notional:
- Maximum market open notional:

## Independent review

- Preparer name/key and timestamp:
- Reviewer name/key and timestamp:
- Approved `MarketConfig` ABI encoding hash:
- Expected `marketId`:
- Expected local question/condition IDs:
- Expected stock/quote YES and NO position IDs:
- Market-admin multisig transaction simulation:

Both reviewers must compare the post-transaction `MarketCreated`, `MarketTermsConfigured`, and `MarketPositionsConfigured` events with this approved artifact.
