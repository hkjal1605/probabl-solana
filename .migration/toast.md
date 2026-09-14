# toast

2026-09-14 · golden pair via shadcn CLI (Base/Nova) · migrated in the main UI.

## Changed

- apps/ui/src/components/ui/toast.tsx:1 — official Base/Nova component, local cn import, formatting and narrowly documented lint compatibility.
- apps/ui/src/modules/FundsPageModule/components/FundsClient.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/PortfolioPageModule/components/PositionActions.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/PortfolioPageModule/components/PendingPayouts.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/hooks/useAsyncAction.ts — consumer or primitive dependency migrated to the local component.
- apps/ui/src/hooks/useOrderTicket.ts — consumer or primitive dependency migrated to the local component.
- apps/ui/src/hooks/useOrderRecovery.ts — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/wallet/WalletButton.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/providers/AppProviders.tsx — consumer or primitive dependency migrated to the local component.

Main UI uses the Base toast manager and provider; all existing notification calls retain their messages and error/success classification. This replaces Sonner under the user's broader common-component request, not as a Radix-only change.

Leftover scan: no radix-ui or @radix-ui imports in this component or main UI source.

## Left alone

packages/ui and apps/admin-ui remain unchanged: they are outside the requested main-UI scope. Brand assets, domain arithmetic, contracts and backend services are unchanged. User-owned skill directories are preserved.

## Behavior changes

Main UI uses the Base toast manager and provider; all existing notification calls retain their messages and error/success classification. This replaces Sonner under the user's broader common-component request, not as a Radix-only change.

## Verify by hand

Review the relevant screen in light/dark themes and on mobile. Tab to controls, check accessible labels and disabled states; open/close overlays and confirm focus returns. For transactions, review fees and cancel before approving a wallet prompt unless intentionally testing a transaction.
