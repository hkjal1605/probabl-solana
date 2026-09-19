import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifact = mkdtempSync(join(tmpdir(), "probabl-sbf-costs-"));
async function run(args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...extra },
  });
  if (await child.exited) throw new Error(`Contract cost gate failed: ${args[0]}`);
}
await run([
  "cargo",
  "build-sbf",
  "--manifest-path",
  "programs/conditional-stocks/Cargo.toml",
  "--sbf-out-dir",
  artifact,
  "--offline",
  "--",
  "--offline",
]);
await run(
  [
    "cargo",
    "test",
    "-p",
    "conditional-stocks",
    "--test",
    "cost_profile",
    "--test",
    "sbf_hardening",
    "--offline",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1",
  ],
  { BPF_OUT_DIR: artifact, RUST_LOG: "error" },
);
console.log(`Verified fresh SBF artifact: ${artifact}`);
