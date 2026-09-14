# project

2026-09-14 · golden pair via shadcn CLI, Base/Nova · main UI migration complete; browser visual review pending.

## Changed

- apps/ui/components.json:1 — Base/Nova registry configuration.
- apps/ui/package.json and bun.lock — Base UI/Recharts and direct theme/utility dependencies; removed the main UI dependency on the Radix-backed shared kit, Sonner and the mistakenly generated cn package. Happy DOM is a development-only interaction-test dependency.
- apps/ui/next.config.ts — no longer transpiles the shared Radix kit.
- apps/ui/src/components/ui — 30 official shadcn primitives, with local imports, Base consumer APIs and limited semantic styling. Per-component reports document details.
- apps/ui/src/styles/global.css — existing theme tokens copied locally, without changing admin styles; obsolete custom panel styles removed.
- apps/ui/src/components/providers/ThemeProvider.tsx and AppProviders.tsx — preserved theme persistence and theme-color behavior, local Base tooltip/toast providers.
- apps/ui/src/components/market — Cards, Tables, Avatars, tooltips, shadcn execution chart; no fabricated historical spot series.
- apps/ui/src/components/layout, wallet and portfolio — Base navigation, sheets, dialogs, tables, badges, callouts, empty/loading states.
- apps/ui/src/modules — migrated home, markets, market detail, funds, portfolio, orders and resolution consumers. Order-book rows now use semantic Tables; order-fill/lifecycle indicators use Progress.
- apps/ui/src/hooks/useConfirmation.tsx — asynchronous issuer-fee consent; cancel on scope change/unmount. Each financial caller rechecks action scope after consent.
- apps/ui/src/hooks/useAsyncAction.ts, useOrderRecovery.ts and useOrderTicket.ts — existing notification messages moved to the Base toast manager.
- apps/ui/test/base-ui.test.ts and test/fixtures/base-ui-interactions.tsx — source migration guard and eight isolated DOM tests: toggles, disabled state, select labels/selection, tabs, accordion, avatar fallback, toast, dialog composition and consent.
- apps/ui/test/devnet-token-metadata.test.ts — asserts Base Avatar fallback and accessible tooltip description instead of native image/title SSR markup; exact metadata mappings remain tested.

Verification:

- Workspace typecheck passed.
- Main UI production build passed.
- Full TypeScript suite: 360 passed, 43 skipped, zero failures. Skips require the compiled local-validator environment, not UI changes.
- Main UI suite: 111 passed, zero failures; its isolated DOM subprocess runs eight additional interaction cases.
- Changed-file lint has no errors; two existing non-null-assertion warnings remain in the explicitly guarded redemption path.
- Local production HTTP checks: /, /markets, /markets/test, /portfolio, /funds, /orders, /resolution and /learn returned 200 without the error boundary.
- Local test server was stopped. No EC2/Cloudflare deployment or GitHub push.
- Source scan: no Radix imports, asChild, Sonner imports, native window.confirm, raw buttons/details/hr, or custom panel consumers in main UI.

## Left alone

- apps/admin-ui and packages/ui: outside this main-UI task; shared admin Radix components are not claimed as migrated.
- Contracts, issuer support, custody math, order review/signing verification, API services, indexer, stores and network call behavior.
- Brand logos/artwork, landing ticker animation and responsive screen layouts.
- Domain-specific signed impact bar and order-book depth shading: these represent financial values, not generic progress, and have no equivalent shadcn primitive. Their containers now use standard UI components.
- Typography remains semantic HTML with shadcn-style type recipes and existing fonts; no invented Typography primitive or wholesale typography/theme preset replacement.
- User-owned .agents, .claude and skills-lock.json files remain untouched.

## Behavior changes

- Base/Nova uses its standard control density, focus styles, Card spacing and rounded corners.
- Tabs use manual keyboard activation: focus does not switch panels; activate with Enter/Space or click.
- Small choice sets use ToggleGroup, not Tabs without panels. A selected required option cannot be cleared; pending trading actions explicitly disable controls.
- Select labels come from items before the popup mounts; nullable changes never erase a token choice.
- Native title tooltips and confirmation popups are replaced by accessible Base components.
- Base Avatar renders initials until an image loads, including SSR.
- Issuer consent is asynchronous. Closing/cancelling or changing wallet/action scope declines it; accepting alone does not bypass the wallet's transaction prompt or verification.
- Claim/payout dialogs cannot dismiss during pending work; tall dialogs scroll.
- The execution chart uses Recharts accessibility and tooltip behavior, with the same execution data/calculations.
- The unused upstream navigation indicator is inert because Base UI has no counterpart; no screen consumes it.

## Verify by hand

1. Review landing, markets Feed/Matrix, market detail, portfolio, funds, orders and resolution on desktop/mobile, in light/dark themes.
2. Check each token name/image, tooltip and fallback; charts with no fills, one branch and both branches; switch ranges and modes.
3. Keyboard-test navigation, selects, toggle groups, manual tabs and accordion disclosure. Check mobile menu closes after navigation and focus returns from dialogs.
4. Connect/refresh the wallet; confirm persistence is unchanged. Review an order, edit values, fund/sign only when intentionally testing, and confirm pending controls cannot change.
5. Exercise issuer-fee cancel/accept, wallet changes, dialog dismissal and payout/claim confirmation. Check errors and successful notifications remain readable.
6. No Playwright or browser automation was used; visual approval remains with the user.

0 main-UI wrappers remain on Radix.
