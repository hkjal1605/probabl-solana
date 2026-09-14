# alert-dialog

2026-09-14 · golden pair via shadcn CLI (Base/Nova) · migrated in the main UI.

## Changed

- apps/ui/src/components/ui/alert-dialog.tsx:1 — official Base/Nova component, local cn import, formatting and narrowly documented lint compatibility.
- apps/ui/src/hooks/useConfirmation.tsx — consumer or primitive dependency migrated to the local component.

Issuer-fee approval uses an asynchronous confirmation dialog. Cancellation, scope changes and unmount resolve false; transaction actions recheck their scope after consent.

Leftover scan: no radix-ui or @radix-ui imports in this component or main UI source.

## Left alone

packages/ui and apps/admin-ui remain unchanged: they are outside the requested main-UI scope. Brand assets, domain arithmetic, contracts and backend services are unchanged. User-owned skill directories are preserved.

## Behavior changes

Issuer-fee approval uses an asynchronous confirmation dialog. Cancellation, scope changes and unmount resolve false; transaction actions recheck their scope after consent.

## Verify by hand

Review the relevant screen in light/dark themes and on mobile. Tab to controls, check accessible labels and disabled states; open/close overlays and confirm focus returns. For transactions, review fees and cancel before approving a wallet prompt unless intentionally testing a transaction.
