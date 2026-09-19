/** Runs services with an isolated owned PostgreSQL cluster. Validator is started
 * separately so shutdown never stops a user's validator or touches another DB. */
import { spawn, type ChildProcess } from "node:child_process";
import { localSolanaDatabase } from "../../packages/db/src/solana/local";

if (!process.env.SOLANA_CONFIG || !process.env.SOLANA_GENESIS_HASH)
  throw new Error("Run bootstrap, then bun --env-file=.local/solana.env scripts/solana/dev.ts");
const database = await localSolanaDatabase(process.env.DATABASE_URL);
const environment = { ...process.env, DATABASE_URL: database.connectionString };
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
  await database.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
// Schema operations are owned by packages/db, before runtime services start.
for (const script of ["migrate", "migrate:solana"]) {
  const migration = spawn(process.execPath, ["run", "--filter", "@conditional-stocks/db", script], {
    stdio: "inherit",
    env: environment,
    detached: true,
  });
  children.push(migration);
  try {
    await new Promise<void>((resolve, reject) => {
      migration.once("error", reject);
      migration.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(script + " failed")),
      );
    });
  } catch (error) {
    await stop();
    throw error;
  }
  children.splice(children.indexOf(migration), 1);
  if (stopping) process.exit(1);
}
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
