import { readFileSync } from "node:fs";
import { SolanaClient, key, address } from "@conditional-stocks/solana-client";
import { Keypair } from "@solana/web3.js";
import { settings } from "./config.ts";
import { apiOrigin } from "./feeds.ts";
import { Executor, signer } from "./execution.ts";
import { Engine, log } from "./engine.ts";
import { StateFile, initialState } from "./state.ts";

async function main() {
  const env = process.env,
    mode = env.MM_MODE ?? "dry-run";
  if (!["dry-run", "live"].includes(mode)) throw new Error("Invalid mode");
  const live = mode === "live";
  if (live && !process.argv.includes("--execute"))
    throw new Error("Live signing requires --execute as well as MM_MODE=live");
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const rpc = required("MM_RPC_URL"),
    url = new URL(rpc);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid RPC transport");
  const config = settings(
    JSON.parse(
      readFileSync(env.MM_CONFIG_PATH ?? "services/market-maker/config.example.json", "utf8"),
    ),
  );
  const client = new SolanaClient({
    rpcUrl: rpc,
    config: address(required("MM_SOLANA_CONFIG")),
    genesisHash: required("MM_GENESIS_HASH"),
    ...(env.MM_PROGRAM_ID ? { programId: address(env.MM_PROGRAM_ID) } : {}),
  });
  await client.assertNetwork();
  const wallet = live
    ? signer(required("MM_PRIVATE_KEY"), address(required("MM_WALLET_ADDRESS")))
    : undefined;
  const owner =
    wallet?.publicKey ??
    (env.MM_WALLET_ADDRESS ? key(address(env.MM_WALLET_ADDRESS)) : Keypair.generate().publicKey);
  const canonical = await client.configAccount();
  if (
    live &&
    [canonical.admin, canonical.seed_authority, ...Object.values(canonical.roles)].some((p) =>
      p.equals(owner),
    )
  )
    throw new Error("Market maker must use a separate, non-governance wallet");
  const scope = [client.deployment.genesisHash, client.program, client.config, owner].join(":");
  const file = live
    ? new StateFile(env.MM_STATE_PATH ?? ".local/market-maker/state.json", scope)
    : undefined;
  const state = file?.state ?? initialState(scope),
    save = () => file?.save();
  const executor = wallet ? new Executor(client, wallet, config, state, save) : undefined;
  const engine = new Engine(
    client,
    owner,
    config,
    apiOrigin(env.MM_API_ORIGIN ?? "https://api-solana.probabl.trade"),
    state,
    save,
    executor,
  );
  const controller = new AbortController();
  const stop = () => {
    engine.stopped = true;
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log("starting", { mode, wallet: owner.toBase58(), markets: config.markets.length });
  try {
    if (process.argv.includes("--cancel")) {
      if (!live) throw new Error("Cancellation needs explicit execution");
      await engine.cancelMarket();
      return;
    }
    if (process.argv.includes("--fund")) {
      await engine.fund();
      return;
    }
    do {
      try {
        await engine.cycle();
      } catch {
        log("cycle-paused", { reason: "Safety check or RPC failed; no blind transaction retry" });
        await engine
          .cancelMarket()
          .catch(() =>
            log("cancel-unavailable", { reason: "Orders retain their on-chain expiry" }),
          );
      }
      if (process.argv.includes("--once") || engine.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, config.pollMs);
        function done() {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", done);
          resolve();
        }
        controller.signal.addEventListener("abort", done, { once: true });
        if (controller.signal.aborted) done();
      });
    } while (!engine.stopped);
  } finally {
    if (engine.stopped)
      await engine
        .cancelMarket()
        .catch(() =>
          log("shutdown-cancel-unavailable", { reason: "Orders retain their on-chain expiry" }),
        );
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    file?.close();
  }
}
main().catch(() => {
  console.error(
    "Market maker stopped: configuration, funding, or safety validation failed. Sensitive diagnostics withheld.",
  );
  process.exitCode = 1;
});
