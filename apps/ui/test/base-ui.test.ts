import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

test("main UI has no Radix, legacy toast, custom panel, or native confirmation consumers", async () => {
  const root = join(import.meta.dir, "../src");
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.(tsx?|css)$/.test(file)) continue;
    const source = await readFile(join(root, file), "utf8");
    expect(source, file).not.toMatch(
      /@radix-ui|radix-ui|@conditional-stocks\/ui-kit|\basChild\b|window\.confirm|from ["']sonner/,
    );
    if (!file.startsWith("components/ui/")) {
      expect(source, file).not.toMatch(/<button\b|<details\b|<hr\b|className="panel\b/);
    }
  }
  const config = JSON.parse(await readFile(join(root, "../components.json"), "utf8"));
  expect(config.style).toBe("base-nova");
});

test("Base UI interactions pass in an isolated DOM environment", async () => {
  const child = Bun.spawn([process.execPath, "test", "./test/fixtures/base-ui-interactions.tsx"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 30_000);
