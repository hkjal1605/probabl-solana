# chart

2026-09-14 · golden pair via shadcn CLI (Base/Nova) · migrated in the main UI.

## Changed

- apps/ui/src/components/ui/chart.tsx:1 — official Base/Nova component, local cn import, formatting and narrowly documented lint compatibility.
- apps/ui/src/components/market/PriceChart.tsx — consumer or primitive dependency migrated to the local component.

Custom SVG execution history replaced with shadcn Chart/Recharts. Real executions, branch separation and last-execution impact calculations are preserved. No synthetic spot history or prices. Config is static application-owned CSS, never untrusted market content.

Leftover scan: no radix-ui or @radix-ui imports in this component or main UI source.

## Left alone

packages/ui and apps/admin-ui remain unchanged: they are outside the requested main-UI scope. Brand assets, domain arithmetic, contracts and backend services are unchanged. User-owned skill directories are preserved.

## Behavior changes

Custom SVG execution history replaced with shadcn Chart/Recharts. Real executions, branch separation and last-execution impact calculations are preserved. No synthetic spot history or prices. Config is static application-owned CSS, never untrusted market content.

## Verify by hand

Review the relevant screen in light/dark themes and on mobile. Tab to controls, check accessible labels and disabled states; open/close overlays and confirm focus returns. For transactions, review fees and cancel before approving a wallet prompt unless intentionally testing a transaction.
