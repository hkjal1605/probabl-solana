# Conditional-stock market maker

One Bun process, one dedicated wallet, one private checkpoint file. No database,
Redis, external signing endpoint, hedging engine or new contract is required.
Dry-run is the default. Nothing starts automatically with the API/indexer.

## Pricing

These books trade **YES-stock against YES-quote** and **NO-stock against NO-quote**.
They are not ordinary prediction shares priced at `p` and `1-p` dollars.

For spot `S` in quote-token units and a reviewed scenario gap `D`:

```
D  = S * gapBps / 10000
Sy = S + (1-p) * D
Sn = S - p * D
p*Sy + (1-p)*Sn = S
```

Example: `S=100`, `p=0.4`, `gapBps=2000` gives `Sy=112`, `Sn=92`.
The equation alone cannot infer the gap. `gapBps=0` is a neutral prior, so both
centers equal spot until a scenario view is configured. It does **not** claim that
the event has no economic effect. Do not infer that effect from the bot's own
quotes or a thin, manipulable local midpoint.

One bid and one ask per branch surround these centers. Prices round outward to
the market tick; sizes round down to its lot size. All token amounts, fees, caps,
probability arithmetic and order prices use integers. Numeric reference prices
are converted once to fixed precision; they are still indicative, not executable
quotes. The paired centers preserve the equation to sub-tick rounding accuracy.
Spreads, inventory constraints, other traders' orders and asynchronous execution
mean actual best bids/asks and last trades will not satisfy an exact identity.

The half-spread includes a minimum, maker fee, adverse-selection buffer, recent
spot movement and probability-book uncertainty. Inventory changes order sizes
rather than breaking the paired center relationship. A branch stops buying at
twice its seeded base inventory, and never offers unowned claims. There is no
automatic leverage, borrowing, self-trading, taker execution or external hedge.
Placement uses an empty maker-leg plan, so it cannot consume liquidity; known
crossing sides are omitted. The program has no global post-only constraint, so a
concurrent external order can still leave a crossed resting book.

See [strategy research](../../docs/market-making-strategy.md) for assumptions,
sources and the important limitations on claims of profitability.

## Configure and run

Use a **separate private env file** based on [.env.example](.env.example). Keep it
mode 0600 in a mode-0700 directory; never copy the deployer/admin env wholesale.
Set `MM_RPC_URL` to the paid endpoint and verify the configured genesis. Set
`MM_CONFIG_PATH` to a reviewed allocation file. Paths are relative to repo root.

- [config.example.json](config.example.json): no markets enabled; logs discovery.
- [config.devnet.example.json](config.devnet.example.json): the existing SPY, BTC
  and ETH devnet markets. These are **test allocations**, not mainnet budgets.
  The current BTC market has a 0.001 BTC lot, so tiny dollar quotes cannot post.

```sh
# No key needed; reads real references and prints hypothetical funded quotes.
bun --env-file=.local/ec2/env/market-maker.env services/market-maker/src/main.ts --once

# Continuous dry-run: omit --once. MM_MODE must still be dry-run.
bun --env-file=.local/ec2/env/market-maker.env services/market-maker/src/main.ts
```

For actual execution, provide `MM_PRIVATE_KEY` (base58 or JSON 64-byte keypair)
and its matching `MM_WALLET_ADDRESS`. The service rejects governance/admin keys.
Set `MM_MODE=live` **and** pass `--execute`; neither switch alone enables signing.
First fund the dedicated wallet with the configured whole base/quote tokens and
SOL for fees/rent. SOL token collateral must already be wrapped SOL in its ATA;
the bot never spends the native gas reserve to wrap or swap assets automatically.

```sh
# Explicit one-time initialization, fee-aware deposits and complete-set splits.
bun --env-file=.local/ec2/env/market-maker.env services/market-maker/src/main.ts --execute --fund

# Start after the allocations and funding receipts have been reviewed.
bun --env-file=.local/ec2/env/market-maker.env services/market-maker/src/main.ts --execute

# Stop the running bot first, then cancel all orders owned by its dedicated wallet.
bun --env-file=.local/ec2/env/market-maker.env services/market-maker/src/main.ts --execute --cancel
```

Funding deposits `baseInventory` and `quoteInventory`, then splits each into equal
YES/NO claim credits. The quotes use **conditional-credit funding**, with matched
branch collateral. Ordinary quoting never deposits more tokens. Funding is
journaled before the first transaction; a completed allocation is not deposited
again, and a partial attempt requires manual inspection. Do not clear this latch
to blindly retry. Unfilled, cancelled and acquired inventory stays in the wallet's
protocol credits. Merge/redeem/withdraw using the existing product/SDK after
stopping the bot; this service does not automatically liquidate or settle.

### Allocation fields

| Field | Meaning |
| --- | --- |
| `market`, `baseMint`, `quoteMint` | Exact allowlisted identities; all three must match chain state. |
| `baseInventory`, `quoteInventory` | One-time whole-token seed amounts, in normal decimal units. Splitting does not double their economic value. |
| `orderQuote` | Maximum conditional-quote notional per order, at most 25% of seed quote inventory. Contract caps can reduce it. |
| `gapBps` | Signed scenario price difference relative to spot, bounded to ±7500. Zero is the neutral prior. |
| `basePriceMultiplier`, `quotePriceMultiplier` | Reviewed multiplier from each reference-price unit to one raw token unit divided by `10^decimals`. Never infer scaled stock units from a ticker. |

Defaults are in `config.example.json`. The 0.1 SOL daily spending cap is a safety
limit, **not an estimate that continuous operation costs 0.1 SOL/day**. Quote
refreshing can exhaust it quickly. Funding rent and estimated transaction debits
are included; bounded cancellation fees can use the emergency reserve afterward.
Drawdown is persistent high-water mark loss in quote units, including escrow;
it is not realized/net-dollar P&L and does not subtract the separate SOL budget.

## Safety and operation

- Fail closed on stale, missing, one-sided, crossed, shallow, extreme-probability
  or mismapped feeds. Both base and quote prices must be available and recent.
  The existing price endpoint remains display-only for the product; **this bot
  explicitly adopts those indicative observations as its own off-chain trading
  inputs**. They never become contract funding or settlement oracles.
- SPL and the protocol-supported Token-2022 extensions reuse the audited client
  policy and fee-aware deposit calculation. Frozen accounts fail simulation.
  Transfer hooks, confidential/rebasing/scaled features not supported by the
  program are **not** silently supported. Arbitrary issuer/token coverage is not
  possible when a compatible price or issuer integration is absent.
- Atomic cancel/replace uses current chain inventory, nonce, fee and sequence.
  No API-provided instructions are signed. Rejected simulations spend no funds.
- A public signature and conservative SOL debit are fsynced before submission.
  Ambiguous submissions block all further signing until signature reconciliation;
  a new salt/transaction is never blindly retried.
- State survives restart: drawdown halts, funding latches, spending counters and
  pending signatures. Do not delete it to resume trading. A cooldown recovers
  automatically; a drawdown halt requires operator review. Avoid manual deposits
  or withdrawals while running because they invalidate P&L interpretation.
- One process/host for this wallet and state file. The local PID lock is not a
  distributed lease. Do not run this wallet from two EC2 hosts or two state paths.
- SIGTERM stops quoting and attempts cancellation. During a complete RPC outage
  cancellation may be impossible; orders become unfillable at their on-chain
  expiry (default 120 seconds), but escrow still needs cancellation to release it.
- `--once` in live mode leaves the resulting orders until cancellation/expiry.
  Error logs expose the failed stage, not raw RPC errors, keys or signed bytes.

Opt-in PM2 configuration: `ops/ec2/solana/market-maker.config.cjs`. Prepare the
private bot env on EC2, use its absolute reviewed config/state paths, then start
that config explicitly. It is **not** added to the existing service group. It
inherits the host's configured PM2 log rotation. Keep exactly one instance.

## Tests

`bun run test:market-maker` runs deterministic strategy, feed, risk-state and
execution-journal tests; `bun run typecheck` includes this workspace.

For real contract tests, start a disposable localhost validator with the compiled
program and run `scripts/solana/bootstrap.ts` into a fresh private fixture directory.
Set `MM_VALIDATOR_FIXTURE` to that directory and run
`bun --no-env-file test services/market-maker/test/validator.test.ts`. Repeat with a
separate bootstrap using `SOLANA_TEST_TOKEN_2022=1` for transfer-fee collateral.
The test rejects non-localhost fixtures. It tests fresh-wallet funding, splits,
four resting orders, a real maker fill, replacement and stale-feed cancellation.

## Production constraint: order-account rent

The current contract creates a new account for every order and does not close it
on cancellation. Quote churn therefore accumulates **non-reclaimed rent and RPC
history**, even without trades. This bot limits that spend and avoids unnecessary
repricing, but cannot fix this contract limitation. Sustained production liquidity
needs measured fill economics and an independently reviewed account reclamation
or reuse design. Do not raise spending limits and call that a profitability fix.
