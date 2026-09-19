import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
async function sources(directory: string, includeDatabase = false): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "out", "cache", "broadcast", "deployments"].includes(entry.name)
      )
        return [];
      const path = `${directory}/${entry.name}`;
      if (!includeDatabase && path === "packages/db")
        return [];
      if (entry.isDirectory()) return sources(path, includeDatabase);
      return /\.(ts|tsx)$/.test(path) ? [path] : [];
    }),
  );
  return nested.flat();
}

test("runtime database schemas and queries are owned exclusively by packages/db", async () => {
  const violations: string[] = [];
  for (const path of (
    await Promise.all(["apps", "packages", "services", "scripts"].map((path) => sources(path)))
  ).flat()) {
    const text = await Bun.file(resolve(root, path)).text();
    if (
      /(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)["'](?:bun:sqlite|pg["']|postgres["']|drizzle-orm)|\b(?:db|database)\s*\.\s*(?:query|select|insert|update|delete|find|exec|run|transaction)\s*(?:\(|\.)|\b(?:onchainTable|onchainEnum)\s*\(|CREATE\s+TABLE|ALTER\s+TABLE/i.test(
        text,
      )
    )
      violations.push(path);
  }
  expect(violations).toEqual([]);
});

test("authored runtime and tests have no embedded SQL database adapters or local-store fallback", async () => {
  const violations: string[] = [];
  const paths = (
    await Promise.all(
      ["apps", "packages", "services", "scripts"].map((path) => sources(path, true)),
    )
  ).flat();
  for (const path of paths) {
    const content = await Bun.file(resolve(root, path)).text();
    if (
      /from\s+["'](?:bun:sqlite|@electric-sql\/pglite|drizzle-orm\/pglite|better-sqlite3|sqlite3)["']|kind:\s*["']pglite["']|create\w+Queries\(["']:memory:["']\)/.test(
        content,
      )
    )
      violations.push(path);
  }
  expect(violations).toEqual([]);
});

test("database package never imports applications or service runtime modules", async () => {
  const violations: string[] = [];
  const pending = ["packages/db/src"];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else {
        const text = await Bun.file(resolve(root, path)).text();
        if (
          /(?:from\s+|import\s*\()["'](?:.*(?:\/apps\/|\/services\/)|@conditional-stocks\/(?:api|web|solana-indexer|market-maker|polymarket-ingestor)(?:["'/]))/.test(
            text,
          )
        )
          violations.push(path);
      }
    }
  }
  expect(violations).toEqual([]);
});
