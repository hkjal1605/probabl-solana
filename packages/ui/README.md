# probabl UI system

Both frontends use `src/styles/global.css`, the shared primitives, `ThemeProvider`,
`ThemeSelect` and `BrandLogo`. The primary color is **#00E191**, sampled from
`assets/logo-name.svg`. No contract identifiers, signing domains, network settings
or authentication storage keys are changed by the visual rebrand.

## Color usage

- Filled primary/brand buttons: `bg-primary text-primary-foreground`, with
  `hover:bg-primary-hover`. Bright green does not support white button text.
- Links, small brand labels and meaningful green icons: `text-brand-strong`.
  This is a darker green in light mode and mint in dark mode.
- Surfaces: `background`, `card`, `popover`, `secondary`, `muted`, `sidebar`.
  Use their corresponding foreground tokens. `muted-foreground` covers supporting text.
  The dark-mode canvas and sidebar use **#0A0C09**, the dominant
  background sampled from `assets/logo-name.jpg`. Elevated cards retain their green tint.
- Status: `positive`, `warning`, `danger`, `info`, each paired with its `-soft`
  background. Buy/YES and sell/NO retain distinct green and rose colors plus labels.
- `border` is a subtle decorative divider; `input` is the higher-contrast control
  boundary. Keyboard focus uses `ring` at full opacity. `overlay` stays dark in both modes.
- Chart strokes use `chart-1` through `chart-5`; also label series, never encode
  financial meaning using color alone.

The theme defaults to the operating-system setting. Each app saves explicit
light/dark/system selection in local storage (`probabl-theme`), synchronized
between same-origin tabs. Different deployment origins keep independent preferences.
The pre-hydration theme script avoids a wrong-theme flash; native controls,
browser theme color and toast notifications follow the resolved theme.

## Assets

Both `public/brand` directories ship exact copies of the original `assets/logo.svg`
and `assets/logo-name.svg`. Headers and footers display the complete outlined
wordmark as a transparent SVG image, not a retyped name. The shared logo component
adds no background in either theme and preserves the original green artwork.
Its transparent padding retains the existing spacing and link hit area.
The compact logo is optional. UI text contrast checks do not apply to logo artwork.
`favicon.svg`, `apple-touch-icon.png`, and `og.png` use the new branding too;
`public/brand/social.svg` is the editable vector source for each social PNG.
If replacing the logo masters, update both apps' public copies together.
The existing metadata domains are retained until actual deployment domains are chosen.

## Verification

Run `bun test packages/ui/test/theme.test.ts`. The regression tests enforce:

- the exact wordmark primary color and equal light/dark semantic-token coverage;
- WCAG AA 4.5:1 normal-text contrast for the tested text/surface, status,
  button, hover, sidebar, and trading pairs;
- 3:1 contrast for control borders, keyboard focus and chart strokes;
- identical shipped logos, background-free rendering and rebranded app metadata.

Also run `bun run typecheck`, `bun test`, `bunx --no-install biome ci .` and both
Next production builds. Check the actual pages at desktop, tablet and mobile
widths, with explicit themes, system changes, reloads, dialogs and error toasts.
Token-level checks are not a substitute for checking new component compositions.
