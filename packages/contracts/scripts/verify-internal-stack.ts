/** Owned local Anvil only. Exercises the deployed service entrypoints, never upstream writes. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStorageProbe } from "@conditional-stocks/db/indexer/verification";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  toHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  atomicTransaction,
  verifyAtomicResponse,
} from "../../../apps/ui/src/lib/trading/atomic.ts";
import { conditionalExchangeAbi } from "../../contract-bindings/src/index.ts";
import { hashOrder, type Order, orderTypedData } from "../../domain/src/index.ts";

const root = resolve(import.meta.dir, "../../..");
const scratch = await mkdtemp(join(tmpdir(), "conditional-stack-"));
const rpcUrl = "http://127.0.0.1:19545";
const ports = {
  indexer: 19546,
  reconciler: 19547,
  api: 19550,
  polymarket: 19551,
  ui: 19552,
  admin: 19553,
};
const url = (name: keyof typeof ports) => `http://127.0.0.1:${ports[name]}`;
const client = createPublicClient({ transport: http(rpcUrl), pollingInterval: 100 });
const children: Array<{
  process: ReturnType<typeof Bun.spawn>;
  logs: Promise<void>;
  name: string;
}> = [];
const checks: string[] = [];
const storageChecks = Bun.argv.includes("--storage");
const rpcReads: { method: string; params: unknown[] }[] = [];
let recordRpc = false;
let rpcProxy: ReturnType<typeof Bun.serve> | undefined;
let env: Record<string, string> = {};
let stopping = false;
const writeJson = (path: string, value: unknown) =>
  Bun.write(
    path,
    `${JSON.stringify(value, (_, item) => (typeof item === "bigint" ? String(item) : item), 2)}\n`,
  );
const spawn = (name: string, cmd: string[], cwd = root, additions: Record<string, string> = {}) => {
  console.info(`START owned local ${name}`);
  const process = Bun.spawn(cmd, {
    cwd,
    env: { ...Bun.env, ...env, ...additions },
    stdout: "pipe",
    stderr: "pipe",
  });
  const logs = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]).then(async ([stdout, stderr]) => {
    await writeJson(join(scratch, `${name}.log.json`), { stdout, stderr });
  });
  children.push({ process, logs, name });
  return process;
};
const until = async (label: string, predicate: () => Promise<boolean>, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  let last = "not ready";
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      last = String(error);
    }
    for (const child of children)
      if (child.process.exitCode !== null && child.name !== "bootstrap")
        throw new Error(`${child.name} exited during ${label}; logs in ${scratch}`);
    await Bun.sleep(250);
  }
  throw new Error(`Timeout: ${label}: ${last}`);
};
const json = async <T = Record<string, unknown>>(
  address: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(address, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok)
    throw new Error(
      `${new URL(address).pathname} returned ${response.status}: ${await response.text()}`,
    );
  return response.json() as Promise<T>;
};
const healthy = async (address: string) => {
  const response = await fetch(address, { signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  return response.ok;
};
const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse())
    if (child.process.exitCode === null) child.process.kill("SIGTERM");
  await Promise.all(
    children.map(async (child) => {
      const timer = setTimeout(() => {
        if (child.process.exitCode === null) child.process.kill("SIGKILL");
      }, 5000);
      await child.process.exited;
      clearTimeout(timer);
      await child.logs;
    }),
  );
  await rpcProxy?.stop(true);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
const pass = (name: string) => {
  checks.push(name);
  console.info(`PASS ${name}`);
};
try {
  // Refuse occupied ports; never attach to someone else's service or chain.
  for (const port of [
    19545,
    ...Object.values(ports),
    19554,
    ...(storageChecks ? [19555, 19556] : []),
  ]) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") });
    await probe.stop(true);
  }
  spawn("anvil", [
    "anvil",
    "--chain-id",
    "31337",
    "--port",
    "19545",
    "--block-time",
    "1",
    "--quiet",
  ]);
  await until("owned Anvil", async () => (await client.getChainId()) === 31337);
  if (storageChecks)
    rpcProxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 19555,
      async fetch(request) {
        const body = await request.text();
        if (recordRpc) {
          const parsed = JSON.parse(body);
          for (const call of Array.isArray(parsed) ? parsed : [parsed])
            rpcReads.push({ method: call.method, params: call.params ?? [] });
        }
        return fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      },
    });
  const completeOneShot = async (name: string, command: string[], cwd = root) => {
    const process = spawn(name, command, cwd);
    const code = await process.exited;
    const child = children.find((item) => item.process === process);
    if (child) {
      await child.logs;
      children.splice(children.indexOf(child), 1);
    }
    if (code !== 0) throw new Error(`${name} failed; logs in ${scratch}`);
  };
  await completeOneShot("initdb", [
    "initdb",
    "-D",
    join(scratch, "postgres"),
    "-A",
    "trust",
    "-U",
    "stack_test",
    "--no-locale",
  ]);
  spawn("postgres", [
    "postgres",
    "-D",
    join(scratch, "postgres"),
    "-p",
    "19554",
    "-h",
    "127.0.0.1",
    "-k",
    scratch,
  ]);
  await until("owned PostgreSQL", async () => {
    const probe = Bun.spawn(["pg_isready", "-h", "127.0.0.1", "-p", "19554", "-U", "stack_test"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await probe.exited) === 0;
  });
  env = {
    DATABASE_URL: "postgresql://stack_test@127.0.0.1:19554/postgres",
    ROBINHOOD_RPC_URL: rpcUrl,
    ROBINHOOD_CHAIN_ID: "31337",
    ANVIL_ENV_OUTPUT: join(scratch, "fixture.env"),
    DEPLOYMENT_OUTPUT_DIRECTORY: join(scratch, "deployments"),
  };
  const bootstrap = spawn("bootstrap", ["bun", "services/rh-indexer/scripts/bootstrap-anvil.ts"]);
  if ((await bootstrap.exited) !== 0) throw new Error(`bootstrap failed: ${scratch}`);
  const fixture = Object.fromEntries(
    (await Bun.file(env.ANVIL_ENV_OUTPUT as string).text())
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  env = {
    ...fixture,
    API_HOST: "127.0.0.1",
    API_PORT: String(ports.api),
    API_URL: url("api"),
    INDEXER_URL: url("indexer"),
    INDEXER_API_URL: url("indexer"),
    DATABASE_URL: "postgresql://stack_test@127.0.0.1:19554/postgres",
    DATABASE_SCHEMA: "internal_stack_test",
    PONDER_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
    INDEXER_BLOCK_RETENTION: "64",
    INDEXER_CACHE_RETENTION: "64",
    INDEXER_CACHE_MAINTENANCE_INTERVAL_MS: "1000",
    ...(storageChecks ? { INDEXER_MAX_HEAD_AGE_SECONDS: "3600" } : {}),
    PONDER_DISABLE_CACHE: "false",
    RECONCILIATION_URL: url("reconciler"),
    RECONCILIATION_API_PORT: String(ports.reconciler),
    RECONCILIATION_INTERVAL_MS: "1000",
    RECONCILIATION_DEEP_INTERVAL_MS: "1000",
    RECONCILIATION_MAX_AGE_MS: "120000",
    POLYMARKET_INGESTOR_URL: url("polymarket"),
    POLYMARKET_PORT: String(ports.polymarket),
    NEXT_PUBLIC_ROBINHOOD_CHAIN_ID: "31337",
    NEXT_PUBLIC_ROBINHOOD_CHAIN_NAME: "Owned Anvil test",
    NEXT_PUBLIC_ROBINHOOD_RPC_URL: rpcUrl,
    NEXT_PUBLIC_ATOMIC_ORDER_ROUTER_ADDRESS: fixture.ATOMIC_ORDER_ROUTER_ADDRESS as string,
    NEXT_PUBLIC_PAYOUT_VAULT_ADDRESS: fixture.PAYOUT_VAULT_ADDRESS as string,
    NEXT_PUBLIC_POSITION_ROUTER_ADDRESS: fixture.POSITION_ROUTER_ADDRESS as string,
    NEXT_PUBLIC_EXCHANGE_ADDRESS: fixture.EXCHANGE_ADDRESS as string,
    NEXT_PUBLIC_CONDITIONAL_TOKENS_ADDRESS: fixture.CONDITIONAL_TOKENS_ADDRESS as string,
    NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS: fixture.MARKET_REGISTRY_ADDRESS as string,
    NEXT_PUBLIC_POLYMARKET_STREAM_URL: `ws://127.0.0.1:${ports.polymarket}`,
    NEXT_PUBLIC_MARKET_ADMIN_ADDRESS: fixture.MARKET_ADMIN as string,
    NEXT_PUBLIC_RESOLUTION_CONTROLLER_ADDRESS: fixture.RESOLUTION_CONTROLLER_ADDRESS as string,
  };
  await Bun.write(
    join(scratch, "stack.env"),
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  spawn(
    "indexer",
    [
      "bun",
      "scripts/ponder.ts",
      Bun.argv.includes("--indexer-dev") ? "dev" : "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(ports.indexer),
    ],
    join(root, "services/rh-indexer"),
    storageChecks ? { ROBINHOOD_RPC_URL: "http://127.0.0.1:19555" } : {},
  );
  await until("indexer", () => healthy(`${url("indexer")}/indexer/health`));
  spawn("reconciler", ["bun", "scripts/reconcile.ts", "watch"], join(root, "services/rh-indexer"));
  await until("reconciler", () => healthy(`${url("reconciler")}/health`));
  spawn("polymarket", ["bun", "src/main.ts"], join(root, "services/polymarket-ingestor"));
  spawn("api", ["bun", "src/index.ts"], join(root, "apps/api"));
  for (const [component, path] of [["api", "/ready"]] as const)
    await until(component, () => healthy(`${url(component)}${path}`));
  pass("all standalone entrypoints ready with active reconciliation");
  const mnemonic = "test test test test test test test test test test test junk";
  const accounts = [7, 8].map((addressIndex) => mnemonicToAccount(mnemonic, { addressIndex }));
  const buyer = accounts[0];
  const seller = accounts[1];
  if (!buyer || !seller) throw new Error("fixture wallets unavailable");
  const exchange = env.EXCHANGE_ADDRESS as Address;
  const marketId = env.MARKET_ID as Hex;
  const mock = await Bun.file(
    join(root, "packages/contracts/out/MockTokens.sol/MockERC20.json"),
  ).json();
  const receipt = async (hash: Hex) => {
    const result = await client.waitForTransactionReceipt({ hash });
    if (result.status !== "success") throw new Error("fixture transaction reverted");
  };
  for (const account of accounts) {
    const wallet = createWalletClient({ account, transport: http(rpcUrl) });
    for (const [token, amount] of [
      [env.USDG_ADDRESS, 10_000_000_000n],
      [env.STOCK_ADDRESS, 100n * 10n ** 18n],
    ] as const) {
      await receipt(
        await wallet.writeContract({
          address: token as Address,
          abi: mock.abi,
          functionName: "mint",
          args: [account.address, amount],
          chain: null,
        }),
      );
      await receipt(
        await wallet.writeContract({
          address: token as Address,
          abi: erc20Abi,
          functionName: "approve",
          args: [exchange, amount],
          chain: null,
        }),
      );
    }
  }
  const auth = async (account: typeof buyer) => {
    const challenge = await json<{ challengeId: string; message: string }>(
      `${url("api")}/v1/auth/challenge`,
      {
        method: "POST",
        body: JSON.stringify({ address: account.address }),
        headers: { "content-type": "application/json" },
      },
    );
    const signature = await account.signMessage({ message: challenge.message });
    return (
      await json<{ token: string }>(`${url("api")}/v1/auth/verify`, {
        method: "POST",
        body: JSON.stringify({
          address: account.address,
          challengeId: challenge.challengeId,
          signature,
        }),
        headers: { "content-type": "application/json" },
      })
    ).token;
  };
  const tokens = new Map([
    [buyer.address, await auth(buyer)],
    [seller.address, await auth(seller)],
  ]);
  const submit = async (account: typeof buyer, side: 0 | 1, tif: 0 | 1, quantity = 10n ** 18n) => {
    const block = await client.getBlock();
    const order: Order = {
      marketId,
      maker: account.address,
      recipient: account.address,
      side,
      branch: 0,
      tif,
      fundingKind: 0,
      quantity,
      limitPriceRawX18: 200_000_000n,
      nonce: 0n,
      salt: keccak256(toHex(crypto.randomUUID())),
      maxFeeBps: 0,
      expiry: block.timestamp + 1800n,
    };
    const signature = await account.signTypedData(
      orderTypedData(order, { chainId: 31337n, verifyingContract: exchange }),
    );
    const serialize = (value: unknown) =>
      JSON.stringify(value, (_, item) => (typeof item === "bigint" ? String(item) : item));
    const post = (path: string, body: unknown) =>
      json<unknown>(`${url("api")}/v1${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.get(account.address)}`,
          "content-type": "application/json",
        },
        body: serialize(body),
      });
    const preparation = (await post("/orders/prepare", { order })) as { plan: unknown };
    const expected = atomicTransaction({
      order: JSON.parse(serialize(order)),
      plan: preparation.plan,
      signature,
      account: account.address,
      config: { chainId: 31337, exchange, atomicRouter: env.ATOMIC_ORDER_ROUTER_ADDRESS as string },
      nowSeconds: (await client.getBlock()).timestamp,
    });
    const transaction = verifyAtomicResponse(
      expected,
      await post("/orders/transaction", { order, plan: preparation.plan, signature }),
    );
    const transactionHash = await createWalletClient({
      account,
      transport: http(rpcUrl),
    }).sendTransaction({
      account,
      chain: null,
      to: transaction.to,
      data: transaction.data,
      value: 0n,
    });
    await receipt(transactionHash);
    const hash = hashOrder(order, { chainId: 31337n, verifyingContract: exchange });
    await until(
      "user placement confirmed in indexer",
      async () =>
        (await json<{ confirmation: string }>(`${url("indexer")}/orders/${hash}`)).confirmation !==
        "observed",
    );
    return { order, hash, transactionHash };
  };
  // Allow confirmation policy to catch up with approvals.
  await Bun.sleep(2500);
  await submit(seller, 1, 0);
  const bid = await submit(buyer, 0, 0);
  await until(
    "atomic GTC fill",
    async () =>
      (await json<{ status: string }>(`${url("indexer")}/orders/${bid.hash}`)).status === "filled",
  );
  pass("GTC quote -> user atomic placement -> canonical fill");
  const ask2 = await submit(seller, 1, 0);
  await until(
    "IOC maker confirmed",
    async () =>
      (await json<{ confirmation: string }>(`${url("indexer")}/orders/${ask2.hash}`))
        .confirmation !== "observed",
  );
  const ioc = await submit(buyer, 0, 1);
  if ((await json<{ status: string }>(`${url("indexer")}/orders/${ioc.hash}`)).status !== "filled")
    throw new Error("Atomic IOC did not fill");
  pass("IOC fills in its user placement transaction");
  const emptyIoc = await submit(buyer, 0, 1);
  const emptyIndexed = await json<{ status: string; filled: string; remaining: string }>(
    `${url("indexer")}/orders/${emptyIoc.hash}`,
  );
  if (
    emptyIndexed.status !== "cancelled" ||
    emptyIndexed.filled !== "0" ||
    emptyIndexed.remaining !== "0"
  )
    throw new Error("Empty IOC did not refund");
  pass("IOC with no liquidity terminates and refunds in the same transaction");
  await submit(seller, 1, 0);
  const partialIoc = await submit(buyer, 0, 1, 2n * 10n ** 18n);
  const partialIndexed = await json<{
    status: string;
    filled: string;
    remaining: string;
    reserved: string;
  }>(`${url("indexer")}/orders/${partialIoc.hash}`);
  if (
    partialIndexed.status !== "cancelled" ||
    partialIndexed.filled !== "1000000000000000000" ||
    partialIndexed.remaining !== "0" ||
    partialIndexed.reserved !== "0"
  )
    throw new Error("IOC history confused the refunded remainder with executed quantity");
  pass("partially filled IOC history preserves executed quantity after atomic refund");
  const recovery = await submit(seller, 1, 0);
  await until(
    "recovery order indexed",
    async () => (await fetch(`${url("indexer")}/orders/${recovery.hash}`)).ok,
  );
  const reconciler = children.find((child) => child.name === "reconciler");
  reconciler?.process.kill("SIGTERM");
  if (reconciler) await reconciler.process.exited;
  const denied = await fetch(`${url("api")}/v1/orders/prepare`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.get(buyer.address)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      { order: { ...bid.order, salt: keccak256(toHex("denied")) } },
      (_, value) => (typeof value === "bigint" ? String(value) : value),
    ),
  });
  if (denied.status !== 503) throw new Error("API did not fail closed without reconciler");
  await receipt(
    await createWalletClient({ account: seller, transport: http(rpcUrl) }).writeContract({
      address: exchange,
      abi: conditionalExchangeAbi,
      functionName: "cancelOrder",
      args: [recovery.hash],
      chain: null,
    }),
  );
  pass("reconciliation outage blocks intake while onchain cancellation remains available");
  if (reconciler) {
    await reconciler.logs;
    children.splice(children.indexOf(reconciler), 1);
  }
  spawn(
    "reconciler-restarted",
    ["bun", "scripts/reconcile.ts", "watch"],
    join(root, "services/rh-indexer"),
  );
  await until("reconciler restart", async () => (await fetch(`${url("reconciler")}/health`)).ok);
  pass("reconciler restarts from its durable store");
  if (storageChecks) {
    const probe = createStorageProbe(env.DATABASE_URL as string, env.DATABASE_SCHEMA as string);
    const storageEvidence: Record<string, unknown> = {};
    const rpc = (method: string, params: unknown[] = []) =>
      client.request({ method, params } as never);
    const assert = (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
    };
    const head = () =>
      json<{ head: { indexedBlock: string; indexedBlockHash: Hex } }>(
        `${url("indexer")}/indexer/health`,
      );
    const sync = async (target: bigint) =>
      until(
        "storage indexer catchup",
        async () => BigInt((await head()).head.indexedBlock) >= target,
      );
    const mine = async (count: number) => {
      await rpc("anvil_mine", [toHex(count), "0x0"]);
      const target = await client.getBlockNumber({ cacheTime: 0 });
      await sync(target);
      return target;
    };
    const stopChild = async (name: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      const child = children.find((item) => item.name === name);
      if (!child) throw new Error(`Missing ${name}`);
      child.process.kill(signal);
      await child.process.exited;
      await child.logs;
      children.splice(children.indexOf(child), 1);
    };
    const startIndexer = (
      name: string,
      additions: Record<string, string> = {},
      port = ports.indexer,
    ) =>
      spawn(
        name,
        [
          "bun",
          "scripts/ponder.ts",
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
          "--log-level",
          "debug",
        ],
        join(root, "services/rh-indexer"),
        { ROBINHOOD_RPC_URL: "http://127.0.0.1:19555", ...additions },
      );
    try {
      // Freeze signing activity; the following workload consists only of local blocks,
      // explicit test cancellation and read-only API/reconciliation requests.
      for (const name of ["api", "polymarket", "reconciler-restarted"]) await stopChild(name);
      await rpc("anvil_setIntervalMining", [0]);
      await mine(256);
      await until(
        "first bounded cache sweep",
        async () => (await probe.stats()).cached_blocks <= 130,
      );
      const before = await probe.stats();
      const anchorNumber = BigInt(before.indexed_block);
      const anchorHash = (await client.getBlock({ blockNumber: anchorNumber })).hash;
      const projection = await probe.projection();
      const began = performance.now();
      await mine(1024);
      storageEvidence.burst = { blocks: 1024, elapsedMs: performance.now() - began };
      await until(
        "second bounded cache sweep",
        async () => (await probe.stats()).cached_blocks <= 130,
      );
      const after = await probe.stats();
      storageEvidence.idle = { before, after };
      assert(before.anchors === 64 && after.anchors === 64, "anchor ring grew during idle blocks");
      assert(after.cached_blocks <= 130, "cache did not converge to its bounded recovery window");
      assert(
        JSON.stringify(projection) === JSON.stringify(await probe.projection()),
        "idle blocks changed protocol rows",
      );
      pass("idle block ring and isolated sync cache remain bounded across 1,280 empty blocks");

      const old = await json<{ hash: Hex }>(
        `${url("indexer")}/internal/canonical-block/${anchorNumber}`,
      );
      assert(old.hash === anchorHash, "evicted block fallback returned wrong hash");
      const candidateQuery = new URLSearchParams({
        marketId,
        branch: "0",
        side: "1",
        atBlock: String(anchorNumber),
        makerFeeBps: "0",
        limitPriceRawX18: "200000000",
        timestamp: String((await client.getBlock()).timestamp),
      });
      const candidates = await json<{ blockHash: Hex }>(
        `${url("indexer")}/internal/match-candidates?${candidateQuery}`,
      );
      assert(candidates.blockHash === anchorHash, "evicted candidate anchor mismatch");
      pass("evicted canonical-block and atomic candidate anchors remain correct");

      const preRestart = await probe.stats();
      const recoveryBlock = BigInt(preRestart.safe_checkpoint.slice(26, 42));
      await stopChild("indexer", "SIGKILL");
      await rpc("anvil_mine", ["0x8", "0x0"]);
      rpcReads.length = 0;
      recordRpc = true;
      startIndexer("indexer-crash-restarted");
      await sync(await client.getBlockNumber({ cacheTime: 0 }));
      recordRpc = false;
      const logReads = rpcReads.filter((call) => call.method === "eth_getLogs");
      const backfillStarts = logReads
        .map((call) => (call.params[0] as { fromBlock?: string }).fromBlock)
        .filter((value): value is string => Boolean(value))
        .map(BigInt);
      assert(
        backfillStarts.every((from) => from >= recoveryBlock),
        "restart refetched an evicted pre-checkpoint prefix",
      );
      assert(
        JSON.stringify(projection) === JSON.stringify(await probe.projection()),
        "crash restart changed protocol state",
      );
      storageEvidence.restart = {
        recoveryBlock,
        backfillStarts,
        rpcRequests: rpcReads.length,
        stats: await probe.stats(),
      };
      pass(
        "SIGKILL restart preserves protocol state and resumes RPC fetching at the durable checkpoint",
      );

      // Snapshot/fork within Ponder's retained unfinalized window after cache eviction.
      const snapshot = await rpc("evm_snapshot");
      const forkBase = await client.getBlockNumber({ cacheTime: 0 });
      const orphanedTransaction = await createWalletClient({
        account: buyer,
        transport: http(rpcUrl),
      }).writeContract({
        address: exchange,
        abi: conditionalExchangeAbi,
        functionName: "cancelUpTo",
        args: [1n],
        chain: null,
      });
      await mine(1);
      await receipt(orphanedTransaction);
      await mine(3);
      assert(
        JSON.stringify(projection) !== JSON.stringify(await probe.projection()),
        "reorg fixture did not index its nonce event",
      );
      const forkTip = await client.getBlock({ blockNumber: forkBase + 4n });
      assert(await rpc("evm_revert", [snapshot]), "Anvil snapshot revert failed");
      await rpc("evm_setNextBlockTimestamp", [Number(forkTip.timestamp) + 1]);
      await mine(5);
      const replacement = await client.getBlock({ blockNumber: forkBase + 4n });
      assert(replacement.hash !== forkTip.hash, "test did not create a different branch");
      await until(
        "reorg anchor rollback",
        async () =>
          (await json<{ hash: Hex }>(`${url("indexer")}/internal/canonical-block/${forkBase + 4n}`))
            .hash === replacement.hash,
      );
      assert(
        JSON.stringify(projection) === JSON.stringify(await probe.projection()),
        "reorg failed to undo protocol event state",
      );
      pass(
        "shallow reorg rolls back protocol events and overwritten ring slots and exposes only replacement anchors",
      );

      await mine(80);
      await until("post-reorg cache sweep", async () => (await probe.stats()).cached_blocks <= 130);
      const pinned = await client.getBlockNumber({ cacheTime: 0 });
      const rebuiltProbe = createStorageProbe(env.DATABASE_URL as string, "storage_rebuild");
      try {
        startIndexer(
          "storage-rebuild",
          {
            DATABASE_SCHEMA: "storage_rebuild",
            INDEXER_END_BLOCK: "",
            INDEXER_CACHE_RETENTION: "1000000",
          },
          19556,
        );
        await until(
          "isolated full replay",
          async () => {
            const response = await json<{ head: { indexedBlock: string } }>(
              "http://127.0.0.1:19556/indexer/health",
            );
            return BigInt(response.head.indexedBlock) === pinned;
          },
          120_000,
        );
        assert(
          JSON.stringify(await probe.projection()) ===
            JSON.stringify(await rebuiltProbe.projection()),
          "full rebuild differs after cache eviction",
        );
        storageEvidence.rebuild = {
          pinned,
          primary: await probe.stats(),
          rebuilt: await rebuiltProbe.stats(),
          projection: await rebuiltProbe.projection(),
        };
        // Same-input, simultaneous local comparison: maintenance enabled vs a
        // large-window cache that performs no eviction during this workload.
        // Sample each block, not every half-second (which aliases the 1s RPC poll).
        // This continuity check's reads can delay its mining clock; the independent
        // audit/indexer-storage/throughput.ts harness measures a sustained block rate.
        const baselineHead = () =>
          json<{ head: { indexedBlock: string } }>("http://127.0.0.1:19556/indexer/health");
        const syncBaseline = (target: bigint) =>
          until(
            "baseline caught up",
            async () => BigInt((await baselineHead()).head.indexedBlock) >= target,
          );
        // Ponder starts at 20 RPC/s and adapts the limit after sustained successful
        // traffic. The fresh full replay has warmed that limiter, while the
        // checkpoint-resumed primary has not. Reset BOTH processes before timing;
        // otherwise we would benchmark unequal RPC budgets, not cache maintenance.
        await Promise.all([stopChild("indexer-crash-restarted"), stopChild("storage-rebuild")]);
        startIndexer("indexer-performance");
        startIndexer(
          "storage-baseline-performance",
          { DATABASE_SCHEMA: "storage_rebuild", INDEXER_CACHE_RETENTION: "1000000" },
          19556,
        );
        await Promise.all([sync(pinned), syncBaseline(pinned)]);
        await Bun.sleep(1200);
        const lag = { bounded: [] as number[], baseline: [] as number[] };
        const scheduled = performance.now();
        const pacedBlocks = 300;
        for (let i = 0; i < pacedBlocks; i++) {
          await rpc("evm_mine");
          const current = await client.getBlockNumber({ cacheTime: 0 });
          const [bounded, baseline] = await Promise.all([head(), baselineHead()]);
          lag.bounded.push(Number(current - BigInt(bounded.head.indexedBlock)));
          lag.baseline.push(Number(current - BigInt(baseline.head.indexedBlock)));
          await Bun.sleep(Math.max(0, scheduled + (i + 1) * 100 - performance.now()));
        }
        const target = await client.getBlockNumber({ cacheTime: 0 });
        await Promise.all([sync(target), syncBaseline(target)]);
        const summarize = (samples: number[]) => {
          const ordered = [...samples].sort((a, b) => a - b);
          return {
            samples,
            meanLagBlocks: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
            p95LagBlocks: ordered[Math.ceil(ordered.length * 0.95) - 1],
            maxLagBlocks: Math.max(...samples),
          };
        };
        storageEvidence.paced = {
          blocks: pacedBlocks,
          elapsedMs: performance.now() - scheduled,
          bounded: summarize(lag.bounded),
          baseline: summarize(lag.baseline),
          boundedStorage: await probe.stats(),
          baselineStorage: await rebuiltProbe.stats(),
        };
        assert(
          Math.max(...lag.bounded) <= Math.max(...lag.baseline) + 20,
          "bounded maintenance introduced a persistent indexing backlog",
        );
        assert(
          JSON.stringify(await probe.projection()) ===
            JSON.stringify(await rebuiltProbe.projection()),
          "paced indexing diverged across cache policies",
        );
        pass("paced comparison catches up with bounded maintenance enabled");
        // Longer identical bursts amortize the independently phased 1s polls.
        // Record both completion clocks concurrently, so waiting for one cannot
        // make the other appear faster. No changes to either indexing config.
        const bursts: { blocks: number; boundedMs: number; baselineMs: number }[] = [];
        for (let round = 0; round < 3; round++) {
          const began = performance.now();
          await rpc("anvil_mine", [toHex(256), "0x0"]);
          const target = await client.getBlockNumber({ cacheTime: 0 });
          const [boundedMs, baselineMs] = await Promise.all([
            sync(target).then(() => performance.now() - began),
            syncBaseline(target).then(() => performance.now() - began),
          ]);
          bursts.push({ blocks: 256, boundedMs, baselineMs });
        }
        storageEvidence.comparisonBursts = bursts;
        await writeJson(join(scratch, "storage-evidence.json"), storageEvidence);
        const boundedTotal = bursts.reduce((sum, round) => sum + round.boundedMs, 0);
        const baselineTotal = bursts.reduce((sum, round) => sum + round.baselineMs, 0);
        assert(
          boundedTotal <= baselineTotal * 1.1 + 1000,
          "bounded-cache burst catch-up regressed beyond local polling/noise tolerance",
        );
        pass("three identical catch-up bursts stay within 10% plus 1s aggregate polling tolerance");
        await stopChild("storage-baseline-performance");
      } finally {
        await rebuiltProbe.close();
      }
      pass(
        "simultaneous fresh-schema replay has an isolated cache and reproduces all protocol tables",
      );
      await stopChild("indexer-performance");
      startIndexer("indexer-clean-restarted");
      await sync(await client.getBlockNumber({ cacheTime: 0 }));
      assert(
        JSON.stringify(await probe.projection()) === JSON.stringify(projection),
        "clean persisted restart changed state",
      );
      pass("clean persisted restart after eviction retains exact canonical protocol state");
      await writeJson(join(scratch, "storage-evidence.json"), storageEvidence);
    } finally {
      recordRpc = false;
      await writeJson(join(scratch, "storage-evidence.json"), storageEvidence);
      await probe.close();
    }
    // Storage comparisons freeze the block clock. Resume it for --hold/browser
    // checks so canonical freshness and confirmation gates can keep advancing.
    await rpc("anvil_setIntervalMining", [1]);
    await rpc("evm_mine");
    if (Bun.argv.includes("--hold") || Bun.argv.includes("--production-ui")) {
      spawn(
        "reconciler-after-storage",
        ["bun", "scripts/reconcile.ts", "watch"],
        join(root, "services/rh-indexer"),
      );
      spawn(
        "polymarket-after-storage",
        ["bun", "src/main.ts"],
        join(root, "services/polymarket-ingestor"),
      );
      spawn("api-after-storage", ["bun", "src/index.ts"], join(root, "apps/api"));
      await until("post-storage trading readiness", () => healthy(`${url("api")}/ready`));
      pass("backend readiness restored after isolated storage benchmark");
    }
  }
  const report = {
    completed: true,
    chainId: 31337,
    upstreamTransactions: 0,
    checks,
    scratch,
    envFile: join(scratch, "stack.env"),
    marketId,
    addresses: { exchange },
    completedAt: new Date().toISOString(),
  };
  const saveReport = async () => {
    report.completedAt = new Date().toISOString();
    await writeJson(join(scratch, "result.json"), report);
    console.info(JSON.stringify(report));
  };
  if (Bun.argv.includes("--hold") || Bun.argv.includes("--production-ui")) {
    if (Bun.argv.includes("--production-ui")) {
      env.PROBABL_REHEARSAL_BUILD = "1";
      await completeOneShot("ui-build", ["bun", "run", "build"], join(root, "apps/ui"));
      await completeOneShot("admin-build", ["bun", "run", "build"], join(root, "apps/admin-ui"));
    }
    const nextCommand = Bun.argv.includes("--production-ui") ? "start" : "dev";
    spawn(
      "ui",
      ["bun", "--bun", "next", nextCommand, "--port", String(ports.ui)],
      join(root, "apps/ui"),
    );
    spawn(
      "admin",
      ["bun", "--bun", "next", nextCommand, "--port", String(ports.admin)],
      join(root, "apps/admin-ui"),
    );
    await until("both frontend entrypoints", async () => {
      const responses = await Promise.all([
        fetch(`${url("ui")}/markets/${marketId}`, { signal: AbortSignal.timeout(10_000) }),
        fetch(`${url("admin")}/`, { signal: AbortSignal.timeout(10_000) }),
      ]);
      return responses.every((response) => response.ok);
    });
    if (Bun.argv.includes("--production-ui"))
      pass("both production frontends build, start and serve against the live local stack");
    await saveReport();
    console.info(`BROWSER_READY ${url("ui")}/markets/${marketId} ${url("admin")} ${scratch}`);
    if (Bun.argv.includes("--hold")) while (!stopping) await Bun.sleep(1000);
  } else await saveReport();
} catch (error) {
  await writeJson(join(scratch, "result.json"), {
    completed: false,
    checks,
    error: String(error),
    scratch,
  });
  console.error(`STACK_FAILED ${scratch}: ${String(error)}`);
  process.exitCode = 1;
} finally {
  await stop();
}
