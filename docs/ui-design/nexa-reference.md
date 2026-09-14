# Main UI design reference

Reference: [Nexa UX/UI](https://www.figma.com/design/a6gP6RxmtsnAHJhae5GhNI/Nexa-UX-UI?node-id=346-15349), inspected in the user's signed-in Edge browser on 2026-09-14. Scope: main UI only, preserving Probabl's screens, data, wallet actions and financial disclosures.

## Inspection coverage and limits

Visited Getting Started, Master Changelog, InsiDeX Trading, Dark Mode and Work In Progress. The populated Dark Mode page is the primary reference. Inspected token tables, the trading terminal, portfolio overview/tokens, favorites, filters, chart menus, connection/audit dialogs, toast variants and sidebar examples. The WIP font comparisons also use Aeonik Pro.

Measurements below come from selected layers in Figma Properties, including resolved spacing aliases. This is a shared-system adaptation, not a claim that every nested layer or every variant has been exhaustively measured. The file does not provide equivalents for all Probabl conditional-market states, a complete mobile specification, or a light theme. Those layouts use the same shared controls and responsive rules; they are not invented Figma measurements.

## Measured dark tokens

| Figma role | Value | UI mapping |
| --- | --- | --- |
| maximized | #000000 | background, popover |
| dialog | #0D0F12 | card, sidebar |
| border-muted | #1B1F23 | border, input |
| foreground | #F0F3F6 | foreground |
| muted-foreground | #9096A5 | muted-foreground |
| primary | #2997FF | primary, focus ring |
| primary-foreground | #D8EBFF | primary-foreground |
| successful | #6ABA90 | positive, trade-buy |
| destructive | #F97782 | destructive, danger, trade-sell |

Hover backgrounds and hover shades are visual approximations. Warning colors retain existing semantics. Probabl's green logo remains its brand identity. Buy/sell buttons use dark text for contrast. The existing optional light theme is a neutral companion, not a Figma-extracted theme.

## Typography and geometry

- Aeonik Pro: real local Light 300, Regular 400, Medium 500 and Bold 700. No synthetic 600 face. Regular is used for body/table values; wallet addresses and transaction identifiers may remain monospace.
- Table/body reference: 14px / 16px, weight 400, zero tracking. Compact controls: 13px; secondary labels: 12px. Standard button label: 13px / 14px, weight 500.
- Standard buttons: 36px high; large: 40px; 6px radius; 6px icon gap.
- Asset table rows: 56px; 12px vertical padding; 32px token identity. Order-book rows have a separate compact density.
- Terminal surfaces adjoin with 1px dividers. Reference order sidebar: 320px. Probabl adds a 280px depth panel on wide screens because it has two conditional books.
- Portfolio content: 1024px; 24px section rhythm; 8px within compact groups. Main content gutters: 16px; terminal gutters: 12px.
- Toast: 312px, padding 12px, gap 8px, radius 7px; title 13px bold, description 12px medium.
- Dropdown reference: 312px, radius 10px, padding 4px. Dialog and field widths adapt to the content rather than clipping financial amounts.
- Amount container: radius 8px, border 1px, padding/gap 8px.

## Implementation

Tokens live in `apps/ui/src/styles/global.css`; font loading is in `src/app/layout.tsx`. Shared shadcn Base UI primitives consume these tokens. `Card` has explicit panel/sidebar variants; `Table` has an opt-in compact density. Page layout distinguishes full-width terminals from centered account content.

The market list, market detail/order ticket, portfolio, orders, funds, resolution, landing and learning screens use the shared system. Refresh notices reserve a stable 16px row, including while inactive, to avoid layout shifts. Missing prices and financial safety messages remain explicit. No API, store, signing, order arithmetic, settlement or smart-contract behavior is changed by this styling pass.

Automated regressions cover font faces, core tokens, card/table variants and stable refresh-notice space, alongside the existing Base UI and trading tests. Browser review does not submit orders, move funds, or request wallet signatures.
