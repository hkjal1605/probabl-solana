# label

2026-09-14 · golden pair via shadcn CLI (Base/Nova) · migrated in the main UI.

## Changed

- apps/ui/src/components/ui/label.tsx:1 — official Base/Nova component, local cn import, formatting and narrowly documented lint compatibility.
- apps/ui/src/components/ui/field.tsx — consumer or primitive dependency migrated to the local component.

Uses the standard shadcn Base/Nova component with existing semantic theme tokens; shared admin primitives are not modified.

Leftover scan: no radix-ui or @radix-ui imports in this component or main UI source.

## Left alone

packages/ui and apps/admin-ui remain unchanged: they are outside the requested main-UI scope. Brand assets, domain arithmetic, contracts and backend services are unchanged. User-owned skill directories are preserved.

## Behavior changes

Standard Base/Nova spacing and focus treatment replace custom styling. No new domain or transaction behavior.

## Verify by hand

Review the relevant screen in light/dark themes and on mobile. Tab to controls, check accessible labels and disabled states; open/close overlays and confirm focus returns. For transactions, review fees and cancel before approving a wallet prompt unless intentionally testing a transaction.
