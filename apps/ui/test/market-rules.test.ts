import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  rulesTextParts,
  safeRulesLink,
} from "../src/modules/MarketDetailPageModule/utils/rulesText";

test("rules preserve exact paragraphs, punctuation and source text", () => {
  const text =
    'Resolves to "Yes" if enacted.\n\nSource (https://congress.gov/bill/3633).\nSee https://example.com/a_(b).';
  const parts = rulesTextParts(text);
  expect(parts.map((part) => part.text).join("")).toBe(text);
  expect(parts.filter((part) => part.href).map((part) => part.href)).toEqual([
    "https://congress.gov/bill/3633",
    "https://example.com/a_(b)",
  ]);
  expect(new Set(parts.map((part) => part.offset)).size).toBe(parts.length);
});

test("rules links reject unsafe protocols, credentials and invalid URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "/relative",
    "https://user:secret@example.com",
    "https://",
  ])
    expect(safeRulesLink(value)).toBeNull();
  expect(safeRulesLink("https://polymarket.com/event/example")).toBe(
    "https://polymarket.com/event/example",
  );
  expect(rulesTextParts("")).toEqual([]);
  const text = "<script>alert(1)</script>\nNo URL.";
  expect(rulesTextParts(text)).toEqual([{ text, href: null, offset: 0 }]);
});

test("top rules trigger opens a dialog instead of a bottom workspace tab", async () => {
  const base = new URL("../src/modules/MarketDetailPageModule/components/", import.meta.url);
  const workspace = await readFile(new URL("MarketWorkspace.tsx", base), "utf8");
  const dialog = await readFile(new URL("MarketRulesDialog.tsx", base), "utf8");
  expect(workspace).toContain("<MarketRulesDialog market={market}");
  expect(workspace).not.toContain('["rules", "Rules"]');
  expect(workspace).not.toContain('<TabsContent value="rules"');
  expect(dialog).toContain("DialogTrigger");
  expect(dialog).toContain("DialogTitle");
  expect(dialog).toContain("rulesTextParts(market.description)");
  expect(dialog).not.toContain("dangerouslySetInnerHTML");
});
