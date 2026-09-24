/** Atomically switch the EC2 services to the reviewed fresh Devnet deployment.
 * Deployment settings arrive as JSON on stdin, never argv/logs. Existing
 * database/auth/provider credentials are retained and never printed.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
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

const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const program = "53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra";
const config = "EfXom6mQxuw5gsHG4AujCgo1dQ3qWg5pN85RvY1ysn23";

/** Per service: its deployment identity names and the settings an update may set. */
export const SERVICES = {
  api: {
    identity: ["SOLANA_GENESIS_HASH", "SOLANA_PROGRAM_ID", "SOLANA_CONFIG"],
    settings: ["SOLANA_ADDRESS_LOOKUP_TABLES", "SOLANA_ISSUER_REPLICA_MINTS", "INDEXER_RELAY_URL"],
  },
  indexer: {
    identity: ["SOLANA_GENESIS_HASH", "SOLANA_PROGRAM_ID", "SOLANA_CONFIG"],
    settings: [
      "SOLANA_ADDRESS_LOOKUP_TABLES",
      "YELLOWSTONE_GRPC_URL",
      "YELLOWSTONE_X_TOKEN",
      "YELLOWSTONE_COMPRESSION",
      "INDEXER_RELAY_PORT",
      "SOLANA_LOOKUP_KEEPER_KEYPAIR",
      "SOLANA_LOOKUP_KEEPER_OWNERS",
    ],
  },
  polymarket: {
    identity: ["SOLANA_GENESIS_HASH", "SOLANA_PROGRAM_ID", "SOLANA_CONFIG"],
    settings: [],
  },
  "market-maker": {
    identity: ["MM_GENESIS_HASH", "MM_PROGRAM_ID", "MM_SOLANA_CONFIG"],
    settings: [
      "SOLANA_ADDRESS_LOOKUP_TABLES",
      "SOLANA_ISSUER_REPLICA_MINTS",
      "MM_CONFIG_PATH",
      "MM_STATE_PATH",
    ],
  },
} as const satisfies Record<string, { identity: readonly string[]; settings: readonly string[] }>;
export type Service = keyof typeof SERVICES;

/** Replace exactly the named settings; every other line and value is retained. */
export function replaceSettings(
  original: string,
  values: Readonly<Record<string, string>>,
  allowed: readonly string[],
) {
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.includes(name)) throw new Error(`${name} is not a deployment setting`);
    if (typeof value !== "string" || /[\r\n$]/.test(value))
      throw new Error(`${name} must be a single line without interpolation`);
    if (name.endsWith("_URL") && value) {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
        throw new Error(`${name} must be an HTTP(S) URL without credentials`);
    }
  }
  const names = new Set(Object.keys(values));
  const retained = original.split("\n").filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !match || !names.has(match[1]!);
  });
  while (retained.at(-1) === "") retained.pop();
  const next = `${[...retained, ...Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`)].join("\n")}\n`;
  const before = parseEnv(original),
    after = parseEnv(next);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!names.has(name) && before[name] !== after[name])
      throw new Error("Unrelated environment setting changed");
  for (const [name, value] of Object.entries(values))
    if (after[name] !== value) throw new Error(`${name} did not round-trip`);
  return next;
}

/** The next env file of one service: the reviewed identity plus its requested settings. */
export function nextEnvironment(
  service: Service,
  original: string,
  settings: Readonly<Record<string, string>> = {},
) {
  const { identity, settings: allowed } = SERVICES[service];
  const [genesisName, programName, configName] = identity;
  if (parseEnv(original)[genesisName] !== genesis) throw new Error("Unexpected Solana network");
  return replaceSettings(
    original,
    { ...settings, [programName]: program, [configName]: config },
    [...allowed, programName, configName],
  );
}

async function main() {
  const root = resolve(import.meta.dir, "../../..");
  if (root !== "/home/ubuntu/probabl-solana" || !process.argv.includes("--execute"))
    throw new Error("This update requires the dedicated EC2 checkout and --execute");
  const input = (await Bun.stdin.text()).trim();
  const requested = (input ? JSON.parse(input) : {}) as Partial<Record<Service, Record<string, string>>>;
  for (const service of Object.keys(requested))
    if (!Object.hasOwn(SERVICES, service)) throw new Error(`Unknown service ${service}`);
  const directory = resolve(root, ".local/ec2/env");
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700)
    throw new Error("Private env directory is required");

  const lock = resolve(directory, ".deployment-update.lock");
  const lockFile = openSync(lock, "wx", 0o600);
  try {
    const records = (Object.keys(SERVICES) as Service[])
      .filter((service) => existsSync(resolve(directory, `${service}.env`)) || requested[service])
      .map((service) => {
        const path = resolve(directory, `${service}.env`);
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== 0o600)
          throw new Error("Private regular env file required");
        const original = readFileSync(path, "utf8");
        return { service, path, original, next: nextEnvironment(service, original, requested[service]) };
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
      JSON.stringify({
        updated: records.map((record) => record.service),
        settings: Object.fromEntries(
          records.map((record) => [record.service, Object.keys(requested[record.service] ?? {})]),
        ),
        program,
        config,
        backupDirectory: backup,
      }),
    );
  } finally {
    closeSync(lockFile);
    unlinkSync(lock);
  }
}

if (import.meta.main)
  main().catch((error) => {
    // Values may be credentials: report only this script's own messages.
    console.error(error instanceof Error && !/[?=@]/.test(error.message) ? error.message : "Deployment update failed");
    process.exitCode = 1;
  });
