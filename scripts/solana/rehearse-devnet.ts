/** Fresh localhost-only validator, generated local test wallet, no .env.devnet. */
import { mkdtemp, open } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { Connection } from "@solana/web3.js";
import { privateDirectory } from "./devnet-store.ts";

async function checkPort(port: number) {
  const server = createServer();
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", yes);
  });
  await new Promise<void>((yes, no) =>
    server.close((error) => (error ? no(error) : yes())),
  );
}
async function main() {
  // Separate from the standard local UI validator (8899) and its faucet.
  const rpcPort = Number(process.env.DEVNET_REHEARSAL_PORT ?? "18997");
  if (!Number.isInteger(rpcPort) || rpcPort < 1024 || rpcPort > 65000)
    throw new Error("Invalid rehearsal RPC port");
  for (let port = rpcPort; port <= rpcPort + 3; port++) await checkPort(port);
  await privateDirectory(resolve(".local/devnet-rehearsals"));
  const directory = await mkdtemp(resolve(".local/devnet-rehearsals/run-"));
  const log = await open(join(directory, "validator.log"), "wx", 0o600);
  const rpc = "http://127.0.0.1:" + rpcPort;
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("DEVNET_")),
  );
  const validator = Bun.spawn(
    [
      "solana-test-validator",
      "--ledger",
      join(directory, "ledger"),
      "--bind-address",
      "127.0.0.1",
      "--rpc-port",
      String(rpcPort),
      "--faucet-port",
      String(rpcPort + 2),
      "--gossip-port",
      String(rpcPort + 3),
      "--dynamic-port-range",
      `${rpcPort + 4}-${rpcPort + 103}`,
      "--limit-ledger-size",
      "1000000",
      "--quiet",
    ],
    { stdout: log.fd, stderr: log.fd, env: childEnv },
  );
  let tests: ReturnType<typeof Bun.spawn> | undefined;
  const stop = () => {
    tests?.kill("SIGTERM");
    validator.kill("SIGINT");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const connection = new Connection(rpc, "confirmed");
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (validator.exitCode !== null)
        throw new Error(
          "Fresh validator exited; inspect " + join(directory, "validator.log"),
        );
      try {
        await connection.getLatestBlockhash();
        ready = true;
        break;
      } catch {
        await Bun.sleep(500);
      }
    }
    if (!ready)
      throw new Error(
        "Fresh validator not ready; inspect " +
          join(directory, "validator.log"),
      );
    console.info(
      "Rehearsing on " + rpc + "; local-only ledger retained at " + directory,
    );
    tests = Bun.spawn(
      [
        process.execPath,
        "test",
        "scripts/solana/test/devnet-validator.test.ts",
        ...(process.env.DEVNET_REHEARSAL_ONLY_UPLOAD === "1"
          ? ["--test-name-pattern", "paced buffer writes"]
          : []),
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...childEnv, DEVNET_PIPELINE_TEST_RPC: rpc },
      },
    );
    process.exitCode = await tests.exited;
  } finally {
    stop();
    const stopped = await Promise.race([
      validator.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!stopped) {
      validator.kill("SIGKILL");
      await validator.exited;
    }
    await log.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
