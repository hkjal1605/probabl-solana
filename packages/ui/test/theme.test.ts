import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../src/styles/global.css");
function palette(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map(([, key, value]) => [key, value]),
  );
}
const light = palette(":root");
const dark = palette(".dark");

test("dark canvas and sidebar match the sampled wordmark JPG black", () => {
  for (const token of ["background", "sidebar"]) {
    expect(dark[token]).toBe("#0a0c09");
  }
  expect(light.background).toBe("#f4f9f6");
});

test("shared logo renders the transparent SVG without a background in either mode", () => {
  const component = read("../src/components/brand-logo.tsx");
  expect(component).not.toMatch(/\bbg-[\w-]+|\bbackground(?:Color)?\s*[:=]/);
  expect(component).toContain('alt="probabl"');
  for (const path of ["/brand/logo.svg", "/brand/logo-name.svg"]) {
    expect(component).toContain(`"${path}"`);
    for (const app of ["ui", "admin-ui"]) {
      const svg = read(`../../../apps/${app}/public${path}`);
      expect(svg).not.toMatch(/<(?:rect|image)\b|background\s*[:=]/i);
    }
  }
});

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  return rgb.reduce((total, v, index) => {
    const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return total + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
  }, 0);
}
function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("both themes define every semantic color and match the original wordmark", () => {
  expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  for (const colors of [light, dark]) {
    expect(colors.primary).toBe("#00e191");
    expect(colors.brand).toBe(colors.primary);
    expect(read("../../../assets/logo-name.svg")).toContain(`fill="${colors.primary}"`);
  }
});

for (const [mode, colors] of Object.entries({ light, dark })) {
  describe(`${mode} palette contrast`, () => {
    const surfaces = ["background", "card", "popover", "muted", "secondary", "sidebar"];
    const assertContrast = (ink: string, surface: string, minimum: number) => {
      const inkColor = colors[ink];
      const surfaceColor = colors[surface];
      if (!inkColor || !surfaceColor) throw new Error(`Missing color: ${ink} or ${surface}`);
      const ratio = contrast(inkColor, surfaceColor);
      expect(ratio, `${mode}: ${ink} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        minimum,
      );
    };
    test("normal, muted, brand, status and trading text meet WCAG AA 4.5:1", () => {
      for (const surface of surfaces) {
        for (const ink of [
          "foreground",
          "muted-foreground",
          "brand-strong",
          "positive",
          "warning",
          "danger",
          "info",
          "trade-buy",
          "trade-sell",
        ]) {
          assertContrast(ink, surface, 4.5);
        }
      }
      for (const surface of [
        "card",
        "popover",
        "primary",
        "secondary",
        "accent",
        "sidebar",
        "sidebar-primary",
        "sidebar-accent",
        "trade-buy",
        "trade-sell",
      ]) {
        assertContrast(`${surface}-foreground`, surface, 4.5);
      }
      assertContrast("primary-foreground", "primary-hover", 4.5);
      assertContrast("brand-strong", "brand-soft", 4.5);
      for (const status of ["positive", "warning", "danger", "info"]) {
        assertContrast(status, `${status}-soft`, 4.5);
      }
    });
    test("input boundaries, keyboard focus and chart strokes meet 3:1", () => {
      for (const surface of surfaces) {
        assertContrast("input", surface, 3);
        assertContrast("ring", surface, 3);
        for (let chart = 1; chart <= 5; chart++) assertContrast(`chart-${chart}`, surface, 3);
      }
    });
  });
}

test("both apps ship the exact vector masters and updated metadata", () => {
  for (const app of ["ui", "admin-ui"]) {
    for (const logo of ["logo.svg", "logo-name.svg"]) {
      expect(read(`../../../apps/${app}/public/brand/${logo}`)).toBe(
        read(`../../../assets/${logo}`),
      );
    }
    const layout = read(`../../../apps/${app}/src/app/layout.tsx`);
    expect(layout).toContain('applicationName: "probabl"');
    expect(layout).toContain('colorScheme: "light dark"');
    expect(layout).toContain("suppressHydrationWarning");
    expect(layout).not.toContain("Conditional Operations");
    expect(layout).not.toContain("%s · Conditional");
  }
});
