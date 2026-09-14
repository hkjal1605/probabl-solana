# accordion

2026-09-14 · golden pair via shadcn CLI (Base/Nova) · migrated in the main UI.

## Changed

- apps/ui/src/components/ui/accordion.tsx:1 — official Base/Nova component, local cn import, formatting and narrowly documented lint compatibility.
- apps/ui/src/modules/MarketDetailPageModule/components/OrderTicket.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/ResolutionPageModule/components/ResolutionClient.tsx — consumer or primitive dependency migrated to the local component.

Native details sections use AccordionItem/Trigger/Content. Inner content no longer forces the panel-height variable onto the measured child; Base UI owns panel measurement.

Leftover scan: no radix-ui or @radix-ui imports in this component or main UI source.

## Left alone

packages/ui and apps/admin-ui remain unchanged: they are outside the requested main-UI scope. Brand assets, domain arithmetic, contracts and backend services are unchanged. User-owned skill directories are preserved.

## Behavior changes

Native details sections use AccordionItem/Trigger/Content. Inner content no longer forces the panel-height variable onto the measured child; Base UI owns panel measurement.

## Verify by hand

Review the relevant screen in light/dark themes and on mobile. Tab to controls, check accessible labels and disabled states; open/close overlays and confirm focus returns. For transactions, review fees and cancel before approving a wallet prompt unless intentionally testing a transaction.
