# Strategy decision: paired, inventory-constrained conditional-stock quotes

## Research conclusion

There is no evidence-backed universally optimal or guaranteed-profitable strategy
for a new conditional-stock book with no fill history. Avellaneda–Stoikov derives
inventory-dependent reservation prices and spread selection under a particular
price process and order-arrival model. That supports managing inventory and
quoting away from an estimate of fair value; it does not establish profitability
for this venue or calibrate its parameters. The model also treats quote changes
as costless, unlike this contract's rent-funded order accounts.
[Original paper](https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf).

Guéant, Lehalle and Fernandez-Tapia explicitly study inventory constraints and
their impact on quote selection. For this initial service, hard inventory limits
and reduced size near those limits are more defensible than fitting arrival-rate
parameters to nonexistent data.
[Inventory-risk paper](https://arxiv.org/abs/1105.3115).

Polymarket describes its displayed price as a bid/ask midpoint, with a last-trade
fallback when the spread is wide. The bot instead requires the existing ingestor's
fresh, two-sided, sufficiently deep YES midpoint and verifies its condition and
outcome orientation. That midpoint is a market-implied proxy, not ground truth or
an authenticated future resolution.
[Price documentation](https://docs.polymarket.com/concepts/prices-orderbook).

Jupiter's V3 prices are reference observations, with heuristics that can exclude
tokens. A token existing on Solana does not guarantee that Jupiter returns a
usable, current price. The bot pauses rather than inventing prices, trusting
unverified timestamps or treating a fetch time as the last market update.
[Price documentation](https://developers.jup.ag/docs/price).

## Adaptation to this product

The implementation is an **inventory-aware heuristic inspired by these models**,
not an implementation of an optimally calibrated stochastic-control solution.
It deliberately has one quote level per side, no optimization solver, no local
midpoint feedback loop and no machine learning.

The proposed relation `S = p Sy + (1-p) Sn` leaves one free parameter. Write the
scenario gap as `D = Sy-Sn`; then `Sy=S+(1-p)D`, `Sn=S-pD`. The operator specifies
`D/S` in basis points. Zero is a neutral starting assumption. Example: spot 100,
probability 0.4, gap 20 gives conditional centers 112 and 92. The centers satisfy
the relation before tick rounding without dividing by tiny probabilities.

This is a **pricing prior**, not a contract-enforced arbitrage theorem. It uses
current spot and a market-implied event probability as proxies for conditional
values. Carry, dividends, issuer basis, resolution timing, risk premia and event/
asset dependence can invalidate that approximation. For volatile quote collateral,
the quote asset's own conditional value also matters; converting its current USD
spot is not a model of that dependence. The shipped devnet example uses USDC.

The matching contract exchanges YES-base for YES-quote and NO-base for NO-quote.
Consequently these prices are conditional exchange ratios, not ordinary YES/NO
prediction-share dollar prices. Splitting both collateral assets creates the
four inventories needed to quote both books without assuming free capital.
Polymarket likewise documents complete sets as backed inventory that can be
created by splitting collateral, but its one-collateral prediction shares are
not the same instruments as this product's two-collateral books.
[Token mechanics](https://docs.polymarket.com/concepts/positions-tokens).

Symmetric spreads preserve paired centers. Inventory skew affects **size** instead
of independently shifting each center and breaking the requested constraint.
Higher uncertainty widens spreads; exceeding the configured safe spread pauses
quoting. Quotes never intentionally take another order. Atomic replacement,
refresh thresholds and short expiries balance continuity, adverse selection
and account-creation costs. Concurrent quotes from other makers do not reject
the bot's placements: the program only rejects a resting quote that would cross
an opposite order placed after the quote was planned, and the bot then replans
against it (see `docs/multi-issuer-markets.md`, "Plans against a moving book").
Quotes appear to takers at the confirmed commitment through the streamed
indexer. Registering the bot's wallet in `SOLANA_LOOKUP_KEEPER_OWNERS` makes its
accounts table-resident in every market before its first quote. None of this
can force other traders' book prices to follow the bot's centers or eliminate
latency exposure.

## What must be measured before a mainnet rollout

Use devnet to validate mechanics, not to infer real profitability. Then collect
realistic order arrivals, fill fraction, time-to-fill, adverse markouts after
fills, inventory imbalance, reference outages, cancels per fill, transaction
costs, non-reclaimed rent, issuer transfer charges, and inventory marked in both
quote units and USD. Replay on held-out periods before increasing capital.
Reject parameter settings that merely earn a gross spread while losing more to
adverse selection or rent. Stock trading halts and corporate actions require
issuer-specific policies; safe behavior without those integrations is to pause.

The implementation's high-water inventory drawdown and SOL spending counter are
risk controls, not a full accounting system or a performance backtest. It does
not hedge directional exposure externally or assume maker rewards exist.
Its defaults are conservative starting controls, not a profitability claim.

**Current blocker to cheap continuous quoting:** each order creates a distinct
rent-funded PDA and cancellation leaves it allocated. A contract account-reuse
or reclamation change needs its own design/review before high-churn production
market making. The service intentionally stops at its spending limit rather
than draining its gas wallet to keep an empty book looking active.
