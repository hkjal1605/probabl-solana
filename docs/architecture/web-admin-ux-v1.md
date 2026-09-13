# Web and admin experience v1

## Scope and product model

Milestone 13 delivers two Next.js 16 applications:

- `apps/ui` is the public, self-custodied trading and portfolio interface;
- `apps/admin-ui` is the role-aware operator interface for manual market creation, manual resolution, safety controls, and audit review;
- `packages/ui` contains the shared Manrope typography, OKLCH color tokens, layout primitives, and shadcn-style components.

Both applications use the same design language as the Levitate reference application: warm ivory surfaces, charcoal type, restrained violet actions, desaturated YES/positive green, and desaturated NO/risk red. Color is never the only branch or state signal.

The v1 product model is deliberately shown in this order:

1. the mapped Polymarket event and its informational YES probability;
2. the executable local Stock Token book if the event resolves YES;
3. the executable local Stock Token book if the event resolves NO.

The two local books are independent CLOBs. The reference probability is not an execution price, and a midpoint is never presented as guaranteed. Stale, disconnected, one-sided, crossed, or insufficient-depth reference data is labeled and withheld from the order flow.

## UX research translated into decisions

Polymarket documents that prices represent implied probabilities, while a trade actually executes against bids or asks in its CLOB. It also distinguishes offchain matching from onchain settlement. Those concepts led to the explicit reference/execution split and canonical-state copy in the UI:

- <https://docs.polymarket.com/concepts/prices-orderbook>
- <https://docs.polymarket.com/trading/overview>
- <https://docs.polymarket.com/concepts/order-lifecycle>

Polymarket and Kalshi both explain limit orders as price-controlled orders that may rest or partially fill. Robinhood likewise emphasizes probability, price, liquidity, and order behavior for event contracts. The order ticket therefore starts with branch and direction, requires an explicit limit or IOC worst price, and reveals funding and contract mechanics only after that primary decision:

- <https://help.polymarket.com/en/articles/13364444-limit-orders>
- <https://help.kalshi.com/en/articles/13823811-limit-orders>
- <https://robinhood.com/us/en/support/articles/robinhood-event-contracts/>
- <https://robinhood.com/us/en/learn/articles/understanding-orders-prices-liquidity-event-contracts/>

Research on prediction-market interfaces reports that information overload and rigid presentation can impair usability. The product therefore uses progressive disclosure: discovery cards carry only event, two branch prices, depth, cutoff, and quality; exact mappings, ladders, and resolution mechanics live behind focused detail tabs. See <https://link.springer.com/article/10.1007/s12525-014-0172-8>.

## Public application

### Routes

| Route | Purpose |
| --- | --- |
| `/` | Product explanation, curated markets, and the event → branch → price mental model |
| `/markets` | Searchable/filterable discovery with both branch books visible |
| `/markets/[marketId]` | Three-panel market detail, local order books, fills, exact terms, resolution explanation, and order ticket |
| `/portfolio` | Canonical whole-token balances, conditional claims, reservations, merge, and redemption |
| `/orders` | Canonical open/partial/filled/canceled order history and direct onchain cancellation |
| `/funds` | Self-custody funding instructions, ERC-20 transfers, and ERC-1155 approval revocation |
| `/resolution` | Manual-review state, evidence, payout vector, resolution transaction, and redeemability |
| `/learn` | Product mechanics, risks, manual-admin boundaries, and direct recovery paths |

### Order safety

- The browser converts human input exactly using verified market token metadata and the v2 raw-unit ratio. It rejects unrepresentable prices or quantities; stock18/USDG6 prices have at most six significant fractional decimal places. Floating-point display values are never reused for signed prices.
- Reservation math uses `@conditional-stocks/domain` integer math; floating point is not used for signed/accounting values.
- The API provides the canonical safe-block preview, funding balance, allowance, exact EIP-712 payload, order hash, and payoff.
- The exact order sent to `/prepare` is retained and signed/submitted unchanged. Editing any form field invalidates that preparation.
- Both GTC and IOC use owner-broadcast atomic placement. The API selects candidates and simulates; the browser constructs its own typed data and exact `placeAndMatch` calldata, verifies the API response, then asks the wallet to send it. There is no relayer fallback.
- The review displays quoted fills, gross execution quote, remainder and deadline. GTC rests its unfilled escrow; IOC refunds it. Stale/failing plans revert entirely and require a fresh review. Contract validity does not imply best-price or complete book clearing.
- Cancellation, merge, redemption, transfers, approval, and approval revocation are wallet-submitted transactions. UI feedback says pending until canonical state changes.

The wallet layer accepts a standard injected EIP-1193 provider. This supports external wallets and host-embedded smart-wallet providers without coupling the protocol UI to one wallet vendor. Selecting a hosted embedded-wallet vendor and provisioning its project credentials is a deployment choice; private keys are never handled by this repository.

### Data and recovery

- Server components read market, order-book, trade, position, balance, and resolution projections.
- Same-origin Next route handlers proxy the Hono API and Ponder indexer, so internal service URLs and authorization handling stay server-side.
- The probability WebSocket client de-duplicates by source hash and reconnects with bounded exponential backoff; server snapshots provide recovery.
- Robinhood Chain events remain canonical. Live mode never silently falls back to fixtures. Explicit demo mode uses an isolated local simulator with visible labeling.
- If the web application or API is unavailable, users retain direct contract paths for cancellation/release, Conditional Tokens merge/redemption, ERC-20 transfers, and ERC-1155 approval revocation.

## Admin application

The admin UI is an orchestration and verification surface, not an authority source. Optional frontend operator allowlisting improves ergonomics; Hono sessions, Safe approvals, and contract roles enforce actual authority.

| Route | Operator workflow |
| --- | --- |
| `/` | Evidence queue and indexer/API/reconciler/ingestor health |
| `/markets/new` | Fetch Gamma metadata into a draft, set immutable local terms/caps/times, and prepare a creation evidence packet |
| `/review` | Independent four-eyes review, reject/approve, simulate, copy Safe payload, and reconcile the executed transaction |
| `/markets` | Review lifecycle/caps and prepare guardian-freeze Safe payloads |
| `/resolutions` | Prepare YES/NO/invalid payout and evidence packets for manual review |
| `/system` | Inspect service health and prepare global pause/resume Safe payloads |
| `/history` | Review append-only admin evidence/audit actions |

Market creation and resolution are manual admin-only functions in v1. Polymarket data pre-fills and supports evidence review only. There is no automatic market creation, resolution watcher, bridge, attestation network, state proof, or cross-chain settlement message.

The creator and reviewer must be different wallets. Immutable fields are summarized before handoff. The application simulates the exact target/value/calldata, copies it as a Safe-compatible payload, and reconciles the eventual transaction against the local evidence packet and canonical chain.

## Explicit v1 exclusions

There is no KYC/KYB, AML/sanctions, geography, investor-status, tax-status, appropriateness, identity wallet allowlist, or compliance-provider flow. Legal access-control design is deferred to a later version after counsel review.

## Configuration and local operation

Copy each application’s `.env.example`, then run:

```bash
bun run dev:ui
bun run dev:admin-ui
```

The public UI uses port `3001`; the admin UI uses `3002`. Production must provide the actual Robinhood Chain RPC/chain ID, explorer, contract addresses, internal API/indexer URLs, and Polymarket stream URL. Public UI demo mode is explicitly selected and isolated from live services; live mode never falls back to dummy data. The former `NEXT_PUBLIC_ENABLE_PREVIEW_DATA` flag is obsolete. See the [demo mode runbook](../runbooks/ui-demo-mode.md).

Production builds and focused tests:

```bash
bun run build:ui
bun run build:admin-ui
bun --filter @conditional-stocks/web test
bun --filter @conditional-stocks/admin-ui test
```

Milestone 14 still owns automated accessibility/visual regression, production wallet-vendor configuration, testnet load testing, security review, multisig rehearsal, and independent audits.
