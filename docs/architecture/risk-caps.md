# V1 risk-cap semantics

The contracts enforce only caps with unambiguous, gas-bounded state:

- maximum quantity and limit-price notional for one order;
- maximum live open notional for one wallet in one market;
- maximum live open notional across one market;
- price tick, base step, and minimum notional.

Open notional is calculated at each order's limit price, added before funding transfer, and reduced proportionally after every fill or completely on cancellation/release. IOC reservations are included while their transaction executes.

Creation uses a conservative constructive feasibility check: one `baseStep` must admit a tick-aligned, uint128-representable price whose rounded-up notional is between the minimum and per-order maximum, and two such orders must fit the market cap. The smallest tick/step product must also round down to at least one quote unit. This rejects dust and unusable two-sided configurations before any condition is prepared. It intentionally rejects some configurations that might work only at larger quantities. The shared TypeScript validator applies the same arithmetic before CLI submission. Passing this check guarantees a configuration witness, not liquidity or receiver/token availability.

These are not identity or loss limits. A wallet cap is Sybil-vulnerable. A filled conditional claim is fully collateralized and leaves exchange escrow, so it no longer counts as open notional. Users can also call Gnosis Conditional Tokens directly to split collateral; therefore this protocol cannot honestly enforce a global cap on all claims outstanding for a condition.

Maximum daily venue volume, active markets per event/stock, and rollout exposure are operational responsibilities monitored from canonical events; they are not automatically enforced by the stateless quote planner. The market admin or guardian freezes the market if an operational cap is reached. These offchain controls are launch safeguards, not solvency assumptions: contract safety continues to rely on full collateralization and signed price/quantity limits.
