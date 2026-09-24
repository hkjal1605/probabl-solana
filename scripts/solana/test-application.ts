/** Fresh local protocol + fresh owned DB + real API/indexer. No demo wallet,
 * liquidity or operational evidence is reused by this integration test. */
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { disposableSolanaDatabase } from "../../packages/db/src/solana/testing";

const database = process.env.TEST_DATABASE_URL,
  rpc = process.env.SOLANA_TEST_RPC ?? process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const local = (value: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
if (
  !database ||
  !local(database) ||
  !["postgres:", "postgresql:"].includes(new URL(database).protocol) ||
  !local(rpc)
)
  throw new Error(
    "Application tests require localhost TEST_DATABASE_URL and a running localhost Solana validator",
  );
const base = resolve(".local");
await mkdir(base, { recursive: true, mode: 0o700 });
const fixtures = await mkdtemp(join(base, "app-test-"));
const databaseFixture = await disposableSolanaDatabase(database);
const dbUrl = new URL(databaseFixture.connectionString);
const processes: ReturnType<typeof Bun.spawn>[] = [];
let interrupted = false;
const onSignal = () => {
  interrupted = true;
  for (const child of processes) if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const run = async (args: string[], env: Record<string, string | undefined>) => {
  if (interrupted) throw new Error("Application rehearsal interrupted");
  const child = Bun.spawn([process.execPath, ...args], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  processes.push(child);
  const result = await child.exited;
  processes.splice(processes.indexOf(child), 1);
  if (result !== 0) throw new Error("Test command failed: " + args.join(" "));
};
try {
  const bootstrapEnv = { ...process.env, SOLANA_RPC_URL: rpc, SOLANA_FIXTURE_DIR: fixtures };
  await run(["scripts/solana/bootstrap.ts"], bootstrapEnv);
  const generated = Object.fromEntries(
    (await Bun.file(join(fixtures, "solana.env")).text())
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  const delegate = Keypair.generate();
  const connection = new Connection(rpc, "confirmed");
  const airdrop = await connection.requestAirdrop(delegate.publicKey, 2_000_000_000);
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const funded = await connection.confirmTransaction({ signature: airdrop, ...blockhash }, "confirmed");
  if (funded.value.err) throw new Error("Generated trading delegate could not be funded");
  // Lookup-table keeper authority for the indexer (appends resting makers' PDAs).
  const keeper = Keypair.generate();
  const keeperAirdrop = await connection.requestAirdrop(keeper.publicKey, 2_000_000_000);
  const keeperFunded = await connection.confirmTransaction(
    { signature: keeperAirdrop, ...(await connection.getLatestBlockhash("confirmed")) },
    "confirmed",
  );
  if (keeperFunded.value.err) throw new Error("Lookup keeper could not be funded");
  const keeperPath = join(fixtures, "lookup-keeper.json");
  await Bun.write(keeperPath, JSON.stringify([...keeper.secretKey]));
  const apiProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
    indexerProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
    relayProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const apiUrl = apiProbe.url.origin,
    indexerUrl = indexerProbe.url.origin;
  const env = {
    ...bootstrapEnv,
    ...generated,
    TRADING_DELEGATE_PRIVATE_KEY: JSON.stringify([...delegate.secretKey]),
    TRADING_DELEGATE_ADDRESS: String(delegate.publicKey),
    DATABASE_URL: dbUrl.toString(),
    TEST_DATABASE_URL: dbUrl.toString(),
    SOLANA_APP_E2E: "1",
    API_PORT: String(apiProbe.port),
    INDEXER_PORT: String(indexerProbe.port),
    API_URL: apiUrl,
    INDEXER_URL: indexerUrl,
    // The API reads the indexer's loopback relay: one upstream stream.
    INDEXER_RELAY_PORT: String(relayProbe.port),
    INDEXER_RELAY_URL: relayProbe.url.origin,
    SOLANA_LOOKUP_KEEPER_KEYPAIR: keeperPath,
    LOG_LEVEL: "warn",
  };
  await apiProbe.stop(true);
  await indexerProbe.stop(true);
  await relayProbe.stop(true);
  await run(["run", "--filter", "@conditional-stocks/db", "migrate:solana"], env);
  for (const file of ["services/solana-indexer/src/main.ts", "apps/api/src/solana.ts"])
    processes.push(
      Bun.spawn([process.execPath, file], { env, stdout: "inherit", stderr: "inherit" }),
    );
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Application rehearsal interrupted");
    if (processes.some((p) => p.exitCode !== null))
      throw new Error("A test service exited before readiness");
    try {
      ready = (await fetch(apiUrl + "/ready", { signal: AbortSignal.timeout(2000) })).ok;
    } catch {}
    if (ready) break;
    await Bun.sleep(250);
  }
  if (!ready) throw new Error("Fresh test stack did not become ready");
  await run(
    [
      "test",
      "packages/solana-client/test/application-e2e.test.ts",
      "apps/api/test/solana/admin.test.ts",
      "services/solana-indexer/test/live-validator.test.ts",
    ],
    env,
  );
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(
    processes.map(async (child) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000);
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  try {
    await databaseFixture.close();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  console.info(
    "Disposable test database removed; generated mock fixture/log context retained at " + fixtures,
  );
}
