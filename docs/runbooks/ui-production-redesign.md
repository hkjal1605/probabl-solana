# Production UI: demo v2 design

The demo v2 visual design now lives in `apps/ui`, backed by the production API,
indexer and locally verified contract transaction builders. The separate
`apps/demo-ui-v2` showcase is not a production data source.

## Screen coverage

| Screen | Production behavior |
| --- | --- |
| Home | Indexed event preview, branch prices, impact and visible book depth; real navigation |
| Markets | Event grouping, filters, search, sorting, feed and matrix views |
| Market | Canonical trade chart, independent YES/NO books, bounded IOC/limit orders, review and atomic placement, positions, orders, claims and rules |
| Portfolio | Wallet balances and reservations, grouped holdings, open orders, claim management, canonical order history export and payout-vault recovery |
| Resolution | Local contract lifecycle, finalized payout vector, evidence and redemption navigation |
| Funds | Wallet funding instructions, exact token transfers and explicit allowance/operator revocations; shared full page and modal |
| Orders | Open/history views, partial fills, fees, cancellation and expired/closed-order escrow release |
| Learn / shell | Product mechanics, transparent wordmark, dark/light themes, mobile navigation, loading/error/not-found states and real-only data |

## Code organization

- `components/ui`, `components/market`, `components/portfolio`: shared Tailwind
  layouts and shadcn/Radix primitives. Trading-app token overrides do not change
  the admin app. Line tabs wrap the shared primitives with explicit merged
  utility classes, so default component styles cannot override them.
- `stores/ui-store.ts`: provider-scoped Zustand store for discovery filters,
  funds-dialog state and one-shot close-position intents. No wallet secrets,
  balances or API results live in this store.
- `lib/api/client.ts`: same-origin API transport with abort/timeout handling,
  typed errors and no mutation retries. Existing server proxies remain the
  boundary to the gateway and indexer; backend credentials stay server-side.
- `hooks/useProtocolData.ts`, `useWalletAssets.ts`, `useTradingReadiness.ts`:
  account/chain/token-keyed React Query caches shared across screens. Public
  markets poll every 10s, orders 6s, positions 8s, fills 5s, readiness 3s.
  The detail page also consumes the configured probability WebSocket. Resolution
  rows are requested only after finalization, not repeatedly for open markets.
- `hooks/useOrderTicket.ts`, `useOrderRecovery.ts`, `useAsyncAction.ts`:
  wallet orchestration separated from rendering. Pending asynchronous work is
  invalidated on context changes/unmount; duplicate local prompts are blocked.
- `lib/trading`: raw integer math, amount conversion and exact local calldata
  construction. Server-selected signing payloads/transaction destinations are
  never accepted without comparison to the reviewed local action.

## Safety and data boundaries

The API still finds atomic match candidates and the deployed contracts still
verify and settle them. No contract, gateway, orderbook, indexer schema or
production configuration was changed for this redesign.

Approvals remain explicit, separate transactions. Claim actions verify the
deployed registry's **local CTF condition**, collateral and decimals. Whole-token
and claim-funded reservations are not double counted. Fees are expressed in bps;
amounts and contract prices remain raw integers. The market-order control is a
1% price-bounded IOC rounded inward to the market tick grid, not an unbounded
execution promise. Previews describe full-fill outcomes and disclose partial-fill
and fee differences.

Older resting orders are fetched separately from the recent-history window and
deduplicated by canonical update block. Reaching an open-order cap withholds
complete reservation totals. Capped or unavailable order books do not produce
invented best quotes. Trading readiness failures do not remove cancellation or
claim-recovery controls. Account switches discard prior reviews/private caches;
expired authentication sessions can be signed in again.

Current backend limitations are intentionally visible:

- No verified historical spot series or complete execution cost basis is exposed;
  spot comparison, average entry and mark-to-entry/P&L are unavailable.
- Charts use the latest 100 indexed fills, not synthetic quote/spot history.
- History/CSV contains canonical order updates, not a complete wallet ledger.
- Displayed depth is not session volume. An unknown asset reference price cannot
  be valued as zero in the portfolio.

These fields need real upstream data before being populated. The demo's financial
fixtures are not present in the application runtime. The saved demo-mode cookie is ignored;
`POST /api/mode` returns 410 and expires it. User resolution screens are read-only. Existing runtime/build environment
requirements are documented in `ui-cloudflare-workers.md`.

## Original redesign verification (before real-only cleanup, 2026-09-10)

- UI test suite: **94 passing tests, 601 assertions**, including amount precision,
  raw-unit/overflow bounds, price ticks, atomic calldata tampering, approvals,
  claim/recovery transactions, mode isolation, action invalidation, order-window
  merging, reservation accounting, evidence URLs and safe CSV encoding.
- Biome lint and TypeScript checks pass. Optimized Next production build passes
  for all routes. No public deployment was performed.
- Playwright browser checks against isolated loopback API/RPC fixtures and an
  injected mock EIP-1193 wallet: discovery/search/views; fractional NO order review,
  approval/signing/atomic submission; resting-order cancellation; fractional
  claim approval and merge; six-decimal USDG transfer; account-switch invalidation;
  rejected sign-in retry; unhealthy-readiness gating; portfolio, resolution,
  educational page, dark/light themes and responsive layouts.
- Mobile/tablet checks used 390px and 900px viewports with no page-level horizontal
  overflow; desktop checked at 1600px. Tables remain independently scrollable.
- Final reload and live-to-demo navigation had no page exceptions; fractional
  demo order review made no backend API or EIP-1193 calls. Screenshots are under
  `output/playwright/production-ui-redesign/` (local artifacts, not deployed).

The fixtures in `apps/ui/test/fixtures` require `PROBABL_UI_FIXTURE=1`, bind only
to `127.0.0.1:4305`, and do not call a real chain. Browser verification exercises
the production UI transport and transaction construction but is **not** evidence
of mainnet transaction settlement, a formal audit, or exhaustive browser coverage.
Production deployment still requires the normal configured-service smoke test and
an explicitly authorized funded-wallet rehearsal. Never deploy a build compiled
with the loopback QA configuration.
