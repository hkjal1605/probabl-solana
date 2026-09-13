# Milestone 13 — Web, portfolio, and admin applications

## Goal

Deliver the complete v1 user and operator experience on top of canonical APIs and contracts, with clear conditional payoffs, executable prices, transaction states, and manual admin workflows.

## Dependencies

- Milestones 10–12 read models, APIs, settlement, and Polymarket data.

## Wallet and onboarding

- Create or connect an embedded smart wallet, with external-wallet support.
- Validate the Robinhood Chain network and guide switching.
- Support ERC-20 approval plus order opening, ERC-1155 operator approval/revocation, sponsored transactions, and user-paid fallback.
- Show pending, confirmed, failed, replaced, and reorged transaction states.
- Present technical/product risk disclosures.
- Do not build KYC/KYB, sanctions, geography, investor-status, tax-status, appropriateness, or wallet-allowlist flows.

## Discovery and market detail

Home/discovery shows:

- curated active markets;
- Polymarket implied probability with source/time/quality;
- executable YES and NO conditional ranges;
- local spread/depth/reliability;
- cutoff and lifecycle state.

Market detail separates:

1. Polymarket event probability;
2. Stock Token if YES;
3. Stock Token if NO.

Also show the ordinary Stock Token reference value, event-impact spread, diagnostic consistency residual, exact terms/mapping, order books, trades, cutoff, resolution process, and warnings. Never display an illiquid midpoint as a guaranteed price.

## Order ticket

- Select branch, buy/sell, quantity, funding source, and GTC/IOC.
- Require an explicit limit or worst acceptable IOC price.
- Preview reservation, expected execution levels, zero v1 fee, raw/formatted amounts, and both outcome payoffs.
- Prefer active claims when closing/rotating; split mixed funding into linked single-source child orders.
- Show order as live only after canonical `OrderOpened` indexing.
- Make cancellations explicit and pending until the chain confirms them.

## Portfolio and history

Show:

- whole Stock Tokens and USDG;
- YES/NO stock and cash claims;
- available versus reserved balances;
- open/partial/filled/canceled/expired orders;
- fills and transaction links;
- event exposure and outcome payoff previews;
- sell, acquire complement, merge, redeem, and withdraw actions.

Merge/redeem actions must explain that direct Conditional Tokens operations remain available if the app is offline.

## Resolution center

- Show awaiting/manual-review/resolved/redeemable status.
- Display the mapped Polymarket condition, final reference outcome, local payout vector, evidence hash/source links, resolution-admin transaction, and timestamp.
- Do not show watcher attestations, bridge status, or automatic-resolution countdowns.

## Admin application

Implement role-protected operator screens for:

- manual market draft, four-eyes review, multisig creation payload, and post-transaction verification;
- lifecycle/cap review and guardian freeze;
- manual resolution packet creation, independent review, transaction simulation, multisig handoff, and onchain reconciliation;
- matcher/indexer/settlement health and incident actions;
- append-only admin-action history.

Frontend role protection is convenience only; contracts enforce actual authority.

## Quality requirements

- Shared domain formatting/math only; do not duplicate price or payout calculations in components.
- Responsive desktop-first experience; mobile-native apps are out of scope.
- Keyboard navigation, semantic labels, color-independent YES/NO states, readable error messages, and accessible order forms.
- WebSocket reconnect and snapshot recovery without duplicate book rows/fills.
- Clear empty, stale, low-liquidity, paused, frozen, unresolved, and unsupported-wallet states.

## Tests

- Component/unit tests for amount and payoff rendering.
- Wallet/network/approval/signing flows.
- E2E buy, sell, cancel, partial fill, close, merge, manual resolve, and redeem.
- Insufficient balance/approval, rejected signature, stale book, frozen market, failed paymaster, and reorged transaction.
- Admin separation of duties and immutable-field confirmation.
- Accessibility audit of critical trading/admin flows.
- Visual regression at supported viewports.

## Deliverables

- `apps/ui`, `apps/admin-ui`, and shared `packages/ui`.
- Market, portfolio, order/fill, deposit/withdraw, and resolution screens.
- Admin creation/resolution/incident screens.
- WebSocket client and resilient local projection behavior.
- User-facing direct recovery documentation.

## Exit criteria

- [x] A user can complete every supported action without CLI access.
- [x] Every financial preview uses the contract/domain integer model and canonical API preparation.
- [x] Canonical chain state is visibly distinguished from optimistic/pending state.
- [x] Admin creation and resolution remain explicit human multisig workflows.
- [x] Low-quality/stale data cannot appear as a reliable executable price.
- [x] No KYC or identity-access flow exists in v1 applications.

Implementation and operating details are recorded in
[`docs/architecture/web-admin-ux-v1.md`](../docs/architecture/web-admin-ux-v1.md). Production wallet-vendor configuration, automated browser E2E/accessibility/visual regression, testnet load testing, multisig rehearsal, and independent security review remain Milestone 14 release gates.

## Non-goals

- Native mobile applications.
- Social trading, copy trading, or portfolio advice.
- Unbounded market orders or future order types.
- KYC/compliance dashboards.
