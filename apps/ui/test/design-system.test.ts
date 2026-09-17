import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "../src/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "../src/components/ui/table";

test("Aeonik uses real local faces for every supported weight, including Regular", async () => {
  const layout = await readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  for (const [face, weight] of [
    ["Light", "300"],
    ["Regular", "400"],
    ["Medium", "500"],
    ["Bold", "700"],
  ]) {
    expect(layout).toContain(`Aeonik Pro ${face}.ttf", weight: "${weight}"`);
    const font = await readFile(
      new URL(`../src/styles/fonts/Aeonik Pro ${face}.ttf`, import.meta.url),
    );
    expect(font.length).toBeGreaterThan(1000);
  }
  expect(layout).toContain("className={aeonik.variable}");
});

test("reference tokens and typography are centralized without the old Manrope CSS dependency", async () => {
  const css = await readFile(new URL("../src/styles/global.css", import.meta.url), "utf8");
  expect(css).not.toContain("@fontsource-variable/manrope");
  for (const token of [
    "--background: #000000",
    "--card: #0d0f12",
    "--foreground: #f0f3f6",
    "--border: #1b1f23",
    "--primary: #00e191",
    "--muted-foreground: #9096a5",
  ]) {
    expect(css).toContain(token);
  }
  expect(css).toContain("--font-weight-semibold: 500");
  expect(css).toContain("font-synthesis: none");
});

test("terminal cards are opt-in variants; ordinary cards retain their default layout", () => {
  const render = (variant?: "panel" | "sidebar") =>
    renderToStaticMarkup(createElement(Card, variant ? { variant } : {}, "Content"));
  expect(render()).toContain('data-variant="default"');
  expect(render("panel")).toContain('data-variant="panel"');
  expect(render("panel")).toContain("data-[variant=panel]:gap-0");
  expect(render("panel")).toContain("data-[variant=panel]:py-0");
  expect(render("sidebar")).toContain('data-variant="sidebar"');
});

test("order books opt into compact density without shrinking asset tables", () => {
  const render = (density?: "compact") =>
    renderToStaticMarkup(
      createElement(
        Table,
        density ? { density } : {},
        createElement(
          TableBody,
          {},
          createElement(TableRow, {}, createElement(TableCell, {}, "123.45")),
        ),
      ),
    );
  expect(render()).toContain('data-density="default"');
  expect(render()).toContain("h-14");
  expect(render("compact")).toContain('data-density="compact"');
  expect(render("compact")).toContain("data-[density=compact]:[&amp;_td]:h-7");
  expect(render()).toContain("overflow-x-auto");
});
