# probabl web app

Next.js App Router front end for the conditional stock markets protocol.

## Run it

```bash
bun install
bun run dev
```

The app starts on http://127.0.0.1:3002.

## How state works

Market data, order books, fills, balances, orders, claims, and trading
permissions are served by the protocol model in `src/protocol/`:

- `catalogue.ts` — the market catalogue: events, their exact terms, and the
  per-asset markets that reference them.
- `engine.ts` — the live protocol model. It advances the order books, the
  reference price feed, and the event probability feed on a fixed tick, matches
  orders against resting depth, and keeps vault balances, conditional claims,
  and orders consistent.
- `config.ts` — token mints, reference price anchors, and account identity.
- `persistence.ts` — balances, orders, and permissions survive a reload through
  browser storage.

`src/services/` reads from that model, so the components, hooks, and stores are
unchanged from the shared UI.

## Flow

1. **Login** connects the trading account, which holds USDC, SPY, NVDA and TSLA.
2. **Deposit** moves whole tokens into the trading vault.
3. **Enable trading** approves the protocol trading key once, with a per-order
   and a lifetime limit.
4. **Trade** places market or limit orders on either branch of any event.
   IOC orders fill against resting depth; GTC orders rest and fill as the book
   trades through them.
5. **Portfolio** shows vault balances, event positions, conditional claims,
   open orders and fills. Claims can be split, merged, and — once a market is
   settled — redeemed.
