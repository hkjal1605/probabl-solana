/** Run on the dedicated EC2 host. New RPC arrives through stdin, never argv/logs.
 * Existing database/auth/provider credentials never leave the server.
 */
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export function replaceRpcSetting(original: string, rpc: string) {
  const url = new URL(rpc);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    /[\r\n\s$]/.test(rpc)
  )
    throw new Error("RPC must be a private HTTPS URL without interpolation");
  const before = parseEnv(original);
  if (!before.SOLANA_RPC_URL) throw new Error("Existing RPC setting is required");
  const retained = original
    .split("\n")
    .filter((line) => !/^\s*(?:export\s+)?SOLANA_RPC_URL\s*=/.test(line));
  while (retained.at(-1) === "") retained.pop();
  const next = `${retained.join("\n")}\nSOLANA_RPC_URL=${JSON.stringify(rpc)}\n`;
  const after = parseEnv(next);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (name !== "SOLANA_RPC_URL" && before[name] !== after[name])
      throw new Error("Unrelated setting changed");
  if (after.SOLANA_RPC_URL !== rpc) throw new Error("RPC value did not round-trip");
  return next;
}

async function main() {
  const root = resolve(import.meta.dir, "../../..");
  if (root !== "/home/ubuntu/probabl-solana" || !process.argv.includes("--execute"))
    throw new Error("This update requires the dedicated EC2 checkout and --execute");
  const rpc = (await Bun.stdin.text()).trim();
  const directory = resolve(root, ".local/ec2/env");
  const dirInfo = lstatSync(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (dirInfo.mode & 0o777) !== 0o700)
    throw new Error("Private env directory is required");
  const lock = resolve(directory, ".rpc-update.lock");
  const fd = openSync(lock, "wx", 0o600);
  try {
    const records = ["api", "indexer"].map((service) => {
      const path = resolve(directory, `${service}.env`),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600)
        throw new Error("Private regular env file required");
      const original = readFileSync(path, "utf8"),
        env = parseEnv(original);
      if (
        env.SOLANA_GENESIS_HASH !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ||
        env.SOLANA_PROGRAM_ID !== "CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3" ||
        env.SOLANA_CONFIG !== "A7t71Mf3PbBuvD8jKXCYQxd9oxrf2woLf3kWszT14mxe"
      )
        throw new Error("Unexpected deployment identity");
      return { service, path, original, next: replaceRpcSetting(original, rpc) };
    });
    const response = await fetch(rpc, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("RPC verification failed");
    const body = (await response.json()) as { result?: string; error?: unknown };
    if (body.error || body.result !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
      throw new Error("RPC network mismatch");
    const backup = mkdtempSync(resolve(directory, "rpc-backup-"));
    chmodSync(backup, 0o700);
    for (const record of records) {
      writeFileSync(resolve(backup, `${record.service}.env.previous`), record.original, {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(resolve(backup, `${record.service}.env.next`), record.next, {
        flag: "wx",
        mode: 0o600,
      });
    }
    for (const record of records)
      if (readFileSync(record.path, "utf8") !== record.original)
        throw new Error("Concurrent env edit detected");
    const activated: typeof records = [];
    try {
      for (const record of records) {
        renameSync(resolve(backup, `${record.service}.env.next`), record.path);
        activated.push(record);
      }
    } catch {
      for (const record of activated) {
        const restore = resolve(backup, `${record.service}.env.restore`);
        writeFileSync(restore, record.original, { flag: "wx", mode: 0o600 });
        renameSync(restore, record.path);
      }
      throw new Error("Environment update rolled back");
    }
    console.log(
      JSON.stringify({
        updatedServices: records.map((r) => r.service),
        changedSetting: "SOLANA_RPC_URL",
        genesisVerified: true,
        unrelatedCredentialsPreserved: true,
        backupDirectory: backup,
      }),
    );
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
if (import.meta.main)
  main().catch(() => {
    console.error(
      "RPC environment update failed; values and diagnostics withheld. No services were restarted.",
    );
    process.exitCode = 1;
  });
