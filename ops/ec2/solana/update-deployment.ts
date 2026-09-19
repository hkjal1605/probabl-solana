/** Atomically switch the three EC2 services to the reviewed fresh Devnet deployment.
 * Existing database/provider credentials are retained and never printed.
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

const root = resolve(import.meta.dir, "../../..");
if (root !== "/home/ubuntu/probabl-solana" || !process.argv.includes("--execute"))
  throw new Error("This update requires the dedicated EC2 checkout and --execute");

const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const program = "8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg";
const config = "6buYkVtSJjaoozCDsPFYrPhp5g1q1oLg2eLp7FpsZ1tF";
const directory = resolve(root, ".local/ec2/env");
const info = lstatSync(directory);
if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700)
  throw new Error("Private env directory is required");

const lock = resolve(directory, ".deployment-update.lock");
const lockFile = openSync(lock, "wx", 0o600);
try {
  const records = ["api", "indexer", "polymarket"].map((service) => {
    const path = resolve(directory, `${service}.env`);
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== 0o600)
      throw new Error("Private regular env file required");
    const original = readFileSync(path, "utf8");
    const before = parseEnv(original);
    if (before.SOLANA_GENESIS_HASH !== genesis) throw new Error("Unexpected Solana network");
    const retained = original
      .split("\n")
      .filter((line) => !/^\s*(?:export\s+)?(?:SOLANA_PROGRAM_ID|SOLANA_CONFIG)\s*=/.test(line));
    while (retained.at(-1) === "") retained.pop();
    const next = `${retained.join("\n")}\nSOLANA_PROGRAM_ID=${JSON.stringify(program)}\nSOLANA_CONFIG=${JSON.stringify(config)}\n`;
    const after = parseEnv(next);
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (name !== "SOLANA_PROGRAM_ID" && name !== "SOLANA_CONFIG" && before[name] !== after[name])
        throw new Error("Unrelated environment setting changed");
    return { service, path, original, next };
  });
  const backup = mkdtempSync(resolve(directory, "deployment-backup-"));
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
      throw new Error("Concurrent environment edit detected");
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
    JSON.stringify({ updated: records.map((record) => record.service), program, config }),
  );
} finally {
  closeSync(lockFile);
  unlinkSync(lock);
}
