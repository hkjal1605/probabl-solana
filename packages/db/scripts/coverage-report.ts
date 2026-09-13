import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const reportPath = process.argv[2] ?? "coverage/shared-postgres/lcov.info";
const records = new Map<
  string,
  { lines: number; hit: number; functions: number; called: number }
>();
for (const block of (await Bun.file(resolve(root, reportPath)).text()).split("end_of_record")) {
  const path = block.match(/^SF:(.+)$/m)?.[1];
  if (!path) continue;
  const value = (key: string) => Number(block.match(new RegExp(`^${key}:(\\d+)$`, "m"))?.[1] ?? 0);
  records.set(path, {
    lines: value("LF"),
    hit: value("LH"),
    functions: value("FNF"),
    called: value("FNH"),
  });
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = `${directory}/${entry.name}`;
        return entry.isDirectory()
          ? files(path)
          : /\.tsx?$/.test(path) && !/\.test\.tsx?$|\.d\.ts$/.test(path)
            ? [path]
            : [];
      }),
    )
  ).flat();
}
const services = ["apps/api", "services/polymarket-ingestor", "services/rh-indexer", "packages/db"];
const entrypoints: Record<string, string[]> = {
  "services/rh-indexer": [
    "services/rh-indexer/scripts/ponder.ts",
    "services/rh-indexer/scripts/preflight.ts",
    "services/rh-indexer/scripts/reconcile.ts",
    "services/rh-indexer/ponder.config.ts",
    "services/rh-indexer/ponder.schema.ts",
  ],
  "packages/db": ["packages/db/scripts/migrate.ts"],
};
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
let complete = true;
for (const service of services) {
  const inventory = [...(await files(`${service}/src`)), ...(entrypoints[service] ?? [])];
  const typeOnly: string[] = [];
  const sources: string[] = [];
  for (const path of inventory) {
    const emitted = transpiler
      .transformSync(await Bun.file(resolve(root, path)).text())
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|export\s*\{\s*\}\s*;?/g, "")
      .trim();
    if (!emitted) typeOnly.push(path);
    else sources.push(path);
  }
  const missing = sources.filter((path) => !records.has(path));
  const measured = sources.flatMap((path) => {
    const record = records.get(path);
    return record ? [{ path, ...record }] : [];
  });
  const total = measured.reduce(
    (sum, r) => ({
      lines: sum.lines + r.lines,
      hit: sum.hit + r.hit,
      functions: sum.functions + r.functions,
      called: sum.called + r.called,
    }),
    { lines: 0, hit: 0, functions: 0, called: 0 },
  );
  const uncovered = measured
    .filter((r) => r.lines !== r.hit || r.functions !== r.called)
    .map((r) => r.path);
  const passed = missing.length === 0 && uncovered.length === 0;
  if (!passed) complete = false;
  console.info(
    JSON.stringify({
      service,
      complete: passed,
      ...total,
      typeOnly,
      unmeasured: missing,
      uncovered,
    }),
  );
}
// No imported-only denominator: unmeasured modules fail the coverage gate too.
process.exitCode = complete ? 0 : 1;
