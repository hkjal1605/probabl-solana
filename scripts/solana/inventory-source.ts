/** Mechanical inventory is not a substitute for reading or auditing source. */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const source = resolve(process.argv[2] ?? "/Volumes/T9/conditional-stocks");
const listing = Bun.spawnSync(
  ["rg", "--files", "--hidden", "-0", "-g", "!.git", "-g", "!node_modules", "-g", "!.worktrees"],
  { cwd: source },
);
if (listing.exitCode !== 0) throw new Error("Source inventory failed");
const reviewed = new Set([
  "packages/contracts/src/AtomicOrderRouter.sol",
  "packages/contracts/test/RegistryHardening.t.sol",
  "packages/contracts/test/ResolutionCommitment.t.sol",
  "packages/contracts/test/AuditFindings.t.sol",
  "packages/contracts/test/SecurityBoundaries.t.sol",
  "packages/contracts/test/SingleMarketAdmin.t.sol",
  "packages/contracts/test/AtomicHardening.t.sol",
  ...["main", "service", "source", "environment", "app", "server", "index", "logger"].map(
    (name) => `services/polymarket-ingestor/src/${name}.ts`,
  ),
]);
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const rows = [];
for (const path of listing.stdout.toString().split("\0").filter(Boolean).sort()) {
  if (/(^|\/)(\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(path) && !path.endsWith(".example"))
    continue;
  if (/\.(pem|key|sqlite|sqlite3|db)$/.test(path) || /keypair|secret|credentials/i.test(path))
    continue;
  const data = await readFile(join(source, path));
  const digest = hash(data),
    code = /\.(ts|tsx|js|jsx|mjs|cjs|sol|rs|sql|py|sh)$/.test(path);
  let destinationHash: string | null = null;
  try {
    destinationHash = hash(await readFile(resolve(path)));
  } catch {}
  rows.push({
    path,
    bytes: data.length,
    sha256: digest,
    code,
    review: reviewed.has(path)
      ? "explicitly-recorded-complete-read"
      : "pending-or-not-individually-recorded",
    destination:
      destinationHash === digest
        ? "identical-copy"
        : destinationHash
          ? "modified"
          : "not-at-original-path",
  });
}
const report = {
  source,
  generatedAt: new Date().toISOString(),
  warning:
    "This checklist deliberately does not certify unrecorded earlier reads. Hashing a file is not reading or auditing it. Full source review is incomplete.",
  excluded:
    "ignored/generated vendor paths, local credentials and databases; rg respects source ignore files",
  files: rows.length,
  codeFiles: rows.filter((r) => r.code).length,
  recordedCompleteReads: rows.filter((r) => r.review === "explicitly-recorded-complete-read")
    .length,
  rows,
};
await mkdir("docs/migration", { recursive: true });
await Bun.write("docs/migration/source-inventory.json", JSON.stringify(report, null, 2) + "\n");
console.info({
  files: report.files,
  codeFiles: report.codeFiles,
  recordedCompleteReads: report.recordedCompleteReads,
});
