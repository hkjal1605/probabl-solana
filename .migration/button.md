# button

2026-09-14 · golden pair via shadcn CLI (Base/Nova) · migrated in the main UI.

## Changed

- apps/ui/src/components/ui/button.tsx:1 — official Base/Nova component, local cn import, formatting and narrowly documented lint compatibility.
- apps/ui/src/modules/FundsPageModule/components/FundsClient.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/MarketDetailPageModule/components/MarketWorkspace.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/MarketDetailPageModule/components/MarketRules.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/MarketDetailPageModule/components/OrderTicket.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/HomePageModule/components/Landing.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/ResolutionPageModule/components/ResolutionClient.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/PortfolioPageModule/components/PositionActions.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/PortfolioPageModule/components/PendingPayouts.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/PortfolioPageModule/components/PortfolioClient.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/modules/OrdersPageModule/components/OrdersClient.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/ui/page.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/app/not-found.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/ui/toast.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/portfolio/PositionTable.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/layout/SiteHeader.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/wallet/WalletButton.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/ui/dialog.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/app/error.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/ui/sheet.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/app/learn/page.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/ui/alert-dialog.tsx — consumer or primitive dependency migrated to the local component.
- apps/ui/src/components/ui/input-group.tsx — consumer or primitive dependency migrated to the local component.

Uses the real Base UI Button. Link composition uses render and nativeButton=false; branded buttons use the standard primary variant. Link ink uses the existing accessible brand-strong token.

Leftover scan: no radix-ui or @radix-ui imports in this component or main UI source.

## Left alone

packages/ui and apps/admin-ui remain unchanged: they are outside the requested main-UI scope. Brand assets, domain arithmetic, contracts and backend services are unchanged. User-owned skill directories are preserved.

## Behavior changes

Uses the real Base UI Button. Link composition uses render and nativeButton=false; branded buttons use the standard primary variant. Link ink uses the existing accessible brand-strong token.

## Verify by hand

Review the relevant screen in light/dark themes and on mobile. Tab to controls, check accessible labels and disabled states; open/close overlays and confirm focus returns. For transactions, review fees and cancel before approving a wallet prompt unless intentionally testing a transaction.
