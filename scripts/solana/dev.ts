/** Runs services with an isolated owned PostgreSQL cluster. Validator is started
 * separately so shutdown never stops a user's validator or touches another DB. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

if (!process.env.SOLANA_CONFIG || !process.env.SOLANA_GENESIS_HASH)
  throw new Error("Run bootstrap, then bun --env-file=.local/solana.env scripts/solana/dev.ts");
const existingDatabase = process.env.DATABASE_URL;
if (existingDatabase) {
  const parsed = new URL(existingDatabase);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  )
    throw new Error("The dev runner accepts only an explicitly configured localhost database");
}
const directory = existingDatabase ? null : await mkdtemp(join(tmpdir(), "probabl-solana-dev-")),
  data = directory ? join(directory, "postgres") : null;
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
  port = probe.port;
await probe.stop(true);
const command = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.once("error", reject);
    p.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(cmd + " exited " + code))));
  });
if (data && directory) {
  await command("initdb", ["-D", data, "-A", "trust", "-U", "probabl_dev"]);
  await command("pg_ctl", [
    "-D",
    data,
    "-l",
    join(directory, "postgres.log"),
    "-o",
    "-h 127.0.0.1 -p " + port + " -k " + directory,
    "start",
  ]);
}
const environment = {
  ...process.env,
  DATABASE_URL: existingDatabase ?? "postgresql://probabl_dev@127.0.0.1:" + port + "/postgres",
};
const children: ChildProcess[] = [];
let stopping = false;
const terminate = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* The owned process group has already exited. */
    }
  }
};
const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) terminate(child, "SIGTERM");
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              terminate(child, "SIGKILL");
              resolve();
            }, 5000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
    ),
  );
  if (data) {
    await command("pg_ctl", ["-D", data, "-m", "fast", "stop"]);
    console.info("Local database and logs remain recoverable at " + directory);
  } else console.info("Externally managed local database left running and unchanged by shutdown");
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
// Source reference-data tables get a full Solana deployment namespace.
const migration = spawn(
  process.execPath,
  ["run", "--filter", "@conditional-stocks/db", "migrate"],
  { stdio: "inherit", env: environment, detached: true },
);
children.push(migration);
try {
  await new Promise<void>((resolve, reject) => {
    migration.once("error", reject);
    migration.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Reference database migration failed")),
    );
  });
} catch (error) {
  await stop();
  throw error;
}
children.splice(children.indexOf(migration), 1);
if (stopping) process.exit(1);
for (const [name, args] of [
  ["indexer", ["services/solana-indexer/src/main.ts"]],
  ["api", ["apps/api/src/solana.ts"]],
  ["web", ["run", "--filter", "@conditional-stocks/web", "dev"]],
  ["admin", ["run", "--filter", "@conditional-stocks/admin-ui", "dev"]],
] as const) {
  const child = spawn(process.execPath, [...args], {
    stdio: "inherit",
    env: environment,
    detached: true,
  });
  children.push(child);
  child.once("error", (e) => {
    console.error(name, e);
    void stop();
  });
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(name + " exited " + code);
      void stop();
    }
  });
}
if (process.env.POLYMARKET_INTERNAL_TOKEN) {
  const ingestor = spawn(process.execPath, ["services/polymarket-ingestor/src/main.ts"], {
    stdio: "inherit",
    env: environment,
    detached: true,
  });
  children.push(ingestor);
  ingestor.once("error", (e) => console.error("Polymarket ingestor", e));
}
console.info(
  "Public UI: http://localhost:3001 · Admin: http://localhost:3002 · Only localnet mock assets.",
);
const databaseLocation = new URL(environment.DATABASE_URL);
databaseLocation.password = "";
console.info("Local database: " + databaseLocation.toString());
