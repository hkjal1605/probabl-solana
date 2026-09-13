/**
 * Real RH mainnet token compatibility checks, executed ONLY on a private local Anvil fork.
 * The upstream RPC proxy accepts read-only methods; there is no path to broadcast upstream.
 * Exit 0 requires complete v2 raw-unit exchange and standalone collateral lifecycles.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
  toHex,
  zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { forkReceipt } from "./fork-receipt.ts";
import { loadArtifact, loadConditionalTokensArtifact } from "./lib.ts";
import { runRawRatioForkLifecycle } from "./raw-ratio-fork-lifecycle.ts";
import { sourceManifest } from "./security.ts";

const root = resolve(import.meta.dir, "../../..");
const started = new Date().toISOString();
const output = resolve(
  root,
  "audit/2026-09-08/atomic-placement/real-token-evidence",
  started.replaceAll(":", "-"),
);
await mkdir(output, { recursive: true });
const upstreamUrl = "https://rpc.mainnet.chain.robinhood.com";
let blockNumber = 0n;
let blockHash: Hex = zeroHash;
const tokens = [
  {
    symbol: "USDG",
    address: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
    holder: getAddress("0x691237472E29087e9c18BE45A1Dd34d0598A6E42"),
    decimals: 6,
    runtimeHash: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
  },
  {
    symbol: "NVDA",
    address: getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"),
    holder: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
    decimals: 18,
    runtimeHash: "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630",
  },
  {
    symbol: "TSLA",
    address: getAddress("0x322F0929c4625eD5bAd873c95208D54E1c003b2d"),
    holder: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
    decimals: 18,
    runtimeHash: "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630",
  },
] as const;
const checks: { name: string; status: "PASS" | "BLOCKED"; detail?: unknown }[] = [];
const transactions: unknown[] = [];
const identities: unknown[] = [];
const methods: Record<string, number> = {};
let deniedWrites = 0;
let protocolCompatible = false;
let completed = false;
let fatalError: string | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let childLog: Promise<void> | undefined;
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const save = (name: string, value: unknown) => Bun.write(resolve(output, name), `${json(value)}\n`);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function pass(name: string, detail?: unknown) {
  checks.push({ name, status: "PASS", detail });
  console.log(`PASS ${name}`);
}

const readOnly = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getProof",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_call",
  "eth_gasPrice",
]);
const pinnedReads = new Map<string, unknown>();
let cachedReadHits = 0;
const deniedMethods: Record<string, number> = {};
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    const body = await request.json();
    const calls = Array.isArray(body) ? body : [body];
    if (calls.some((call) => !readOnly.has(call.method))) {
      deniedWrites++;
      for (const call of calls)
        if (!readOnly.has(call.method))
          deniedMethods[call.method] = (deniedMethods[call.method] ?? 0) + 1;
      const errors = calls.map((call) => ({
        jsonrpc: "2.0",
        id: call.id,
        error: { code: -32601, message: "Read-only fork source: method forbidden" },
      }));
      return Response.json(Array.isArray(body) ? errors : errors[0]);
    }
    for (const call of calls) methods[call.method] = (methods[call.method] ?? 0) + 1;
    const key = (call: { method: string; params?: unknown }) =>
      JSON.stringify([call.method, call.params]);
    const cacheable = (call: { method: string; params?: unknown }) =>
      ["eth_chainId", "net_version"].includes(call.method) ||
      (!["eth_blockNumber", "eth_gasPrice"].includes(call.method) &&
        !/"(?:latest|pending|safe|finalized)"/.test(JSON.stringify(call.params)));
    const missing = calls.filter((call) => !(cacheable(call) && pinnedReads.has(key(call))));
    cachedReadHits += calls.length - missing.length;
    const combine = (responses: { id: unknown; result?: unknown; error?: unknown }[]) => {
      const combined = calls.map((call) =>
        cacheable(call) && pinnedReads.has(key(call))
          ? { jsonrpc: "2.0", id: call.id, result: pinnedReads.get(key(call)) }
          : responses.find((response) => response.id === call.id),
      );
      return Response.json(Array.isArray(body) ? combined : combined[0]);
    };
    if (missing.length === 0) return combine([]);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(upstreamUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Array.isArray(body) ? missing : missing[0]),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        if ((response.status === 429 || text.includes("Too Many Requests")) && attempt < 3) {
          await Bun.sleep(1000 * (attempt + 1));
          continue;
        }
        if (!response.ok) throw new Error(`Read-only RPC HTTP ${response.status}: ${text}`);
        const parsed = JSON.parse(text);
        const results = Array.isArray(parsed) ? parsed : [parsed];
        for (const call of missing) {
          const result = results.find((item) => item.id === call.id);
          if (cacheable(call) && result && !result.error && "result" in result)
            pinnedReads.set(key(call), result.result);
        }
        return combine(results);
      } catch (error) {
        if (attempt === 3)
          return Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32000, message: String(error) } },
            { status: 502 },
          );
      }
    }
    return new Response("RPC retry limit", { status: 502 });
  },
});
const source = createPublicClient({
  transport: http(`http://127.0.0.1:${proxy.port}`, { timeout: 45_000, retryCount: 1 }),
});
// Separate fixed localhost endpoint; neither wallet nor impersonation calls use the upstream client.
const localUrl = "http://127.0.0.1:18547";
const local = createPublicClient({
  cacheTime: 0,
  transport: http(localUrl, { timeout: 60_000, retryCount: 0 }),
  pollingInterval: 20,
});
const localRpc = <T>(method: string, params: unknown[] = []): Promise<T> =>
  local.request({ method, params } as never) as Promise<T>;
const localPrivateKey = generatePrivateKey();
const account = privateKeyToAccount(localPrivateKey);
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const wallet = createWalletClient({ account, transport: http(localUrl), chain: undefined });
const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
  local.readContract({ address, abi, functionName, args });
const balance = (address: Address, owner: Address) =>
  read(address, erc20Abi, "balanceOf", [owner]) as Promise<bigint>;
async function write(
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
) {
  const simulation = await local.simulateContract({
    account,
    address,
    abi,
    functionName,
    args,
    type: "eip1559",
  });
  const hash = await wallet.writeContract({
    account,
    address,
    abi,
    functionName,
    args,
    chain: null,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const receipt = await forkReceipt(local, hash);
  assert(receipt.status === "success", `${functionName}: transaction reverted`);
  transactions.push({
    address,
    functionName,
    args,
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    status: receipt.status,
  });
  return simulation.result;
}
async function deploy(name: string, abi: Abi, bytecode: Hex, args: readonly unknown[] = []) {
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args,
    chain: null,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const receipt = await forkReceipt(local, hash);
  assert(receipt.status === "success" && receipt.contractAddress, `${name}: deployment failed`);
  const address = receipt.contractAddress;
  const code = await local.getCode({ address });
  assert(code && code !== "0x", `${name}: no runtime`);
  transactions.push({
    name,
    hash,
    address,
    args,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    runtimeHash: keccak256(code),
  });
  return address;
}

try {
  assert((await source.getChainId()) === 4663, "Upstream is not RH mainnet");
  // Pin a single current canonical block for the entire run. Public RPC providers
  // need not retain arbitrary historical account state for the old audit's block.
  const block = await source.getBlock({ blockTag: "latest" });
  blockNumber = block.number;
  blockHash = block.hash;
  await save("block.json", {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
    sourceChainId: 4663,
  });
  const assetsResponse = await fetch("https://api.robinhood.com/rhj/assets", {
    signal: AbortSignal.timeout(30_000),
  });
  assert(assetsResponse.ok, "Official asset registry unavailable");
  const assets = (await assetsResponse.json()) as {
    assets: { tokenSymbol: string; deployments: { chainId: number; contractAddress: string }[] }[];
  };
  const selectedAssets = assets.assets.filter((asset) =>
    ["NVDA", "TSLA"].includes(asset.tokenSymbol),
  );
  for (const token of tokens.slice(1)) {
    assert(
      selectedAssets.some(
        (asset) =>
          asset.tokenSymbol === token.symbol &&
          asset.deployments.some(
            (entry) =>
              entry.chainId === 4663 && getAddress(entry.contractAddress) === token.address,
          ),
      ),
      `${token.symbol}: official registry mismatch`,
    );
  }
  const contractsResponse = await fetch("https://docs.robinhood.com/chain/contracts/", {
    signal: AbortSignal.timeout(30_000),
  });
  assert(contractsResponse.ok, "Official USDG directory unavailable");
  const contractsPage = await contractsResponse.text();
  assert(
    contractsPage.toLowerCase().includes(tokens[0].address.toLowerCase()),
    "Official USDG address mismatch",
  );
  await save("official-assets.json", {
    retrievedAt: new Date().toISOString(),
    url: "https://api.robinhood.com/rhj/assets",
    assets: selectedAssets,
  });
  await save("official-usdg.json", {
    url: "https://docs.robinhood.com/chain/contracts/",
    address: tokens[0].address,
    htmlSha256: createHash("sha256").update(contractsPage).digest("hex"),
  });
  await Bun.write(resolve(output, "official-token-directory.html"), contractsPage);
  pass("Canonical USDG/NVDA/TSLA identities and RH block pinned");

  const denied = (await fetch(`http://127.0.0.1:${proxy.port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "eth_sendRawTransaction",
      params: ["0x"],
    }),
  }).then((response) => response.json())) as { error?: { code: number } };
  assert(denied.error?.code === -32601, "Upstream write guard failed");
  pass("Upstream transaction submission is rejected locally");
  // Never attach to an existing local session or accidentally modify somebody else's fork.
  let occupied = false;
  try {
    await fetch(localUrl, { signal: AbortSignal.timeout(300) });
    occupied = true;
  } catch {
    /* no listener */
  }
  assert(!occupied, "Port 18547 is already in use; stop or relocate that session first");
  const anvil = Bun.spawn(
    [
      "anvil",
      "--host",
      "127.0.0.1",
      "--port",
      "18547",
      "--accounts",
      "0",
      "--quiet",
      "--no-storage-caching",
      "--fork-url",
      `http://127.0.0.1:${proxy.port}`,
      "--fork-block-number",
      blockNumber.toString(),
      "--chain-id",
      "4663",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  child = anvil;
  childLog = Promise.all([
    new Response(anvil.stdout).text(),
    new Response(anvil.stderr).text(),
  ]).then(async ([stdout, stderr]) => {
    await Bun.write(resolve(output, "anvil.stdout.log"), stdout);
    await Bun.write(resolve(output, "anvil.stderr.log"), stderr);
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await localRpc<string>("web3_clientVersion")).toLowerCase().includes("anvil")) {
        ready = true;
        break;
      }
    } catch {
      /* startup */
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(250);
  }
  assert(ready, "Local Anvil did not start");
  assert((await local.getChainId()) === 4663, "Fork chain ID changed");
  assert(
    (await local.getBlock({ blockNumber })).hash === blockHash,
    "Local fork is not the pinned block",
  );
  await save("anvil-node-info.json", await localRpc("anvil_nodeInfo"));
  pass("Local Anvil fork retains RH mainnet chain ID and pinned block hash");
  await localRpc("anvil_setBalance", [account.address, toHex(100n * 10n ** 18n)]);

  const slots = {
    implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
    admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  } as const;
  for (const token of tokens) {
    const code = await source.getCode({ address: token.address, blockNumber });
    assert(
      code && keccak256(code) === token.runtimeHash,
      `${token.symbol}: pinned runtime differs`,
    );
    assert(
      (await local.getCode({ address: token.address })) === code,
      `${token.symbol}: local runtime differs`,
    );
    const decimals = await read(token.address, erc20Abi, "decimals");
    assert(decimals === token.decimals, `${token.symbol}: decimals changed`);
    const storage: Record<string, Hex | undefined> = {};
    const dependencies: unknown[] = [];
    for (const [name, slot] of Object.entries(slots)) {
      const value = await source.getStorageAt({ address: token.address, slot, blockNumber });
      storage[name] = value;
      assert(
        (await local.getStorageAt({ address: token.address, slot })) === value,
        `${token.symbol}: fork proxy slot differs`,
      );
      if (value && value !== zeroHash) {
        const dependency = getAddress(`0x${value.slice(-40)}`);
        const dependencyCode = await source.getCode({ address: dependency, blockNumber });
        if (dependencyCode && dependencyCode !== "0x") {
          dependencies.push({
            kind: name,
            address: dependency,
            runtimeHash: keccak256(dependencyCode),
            runtime: dependencyCode,
          });
          assert(
            (await local.getCode({ address: dependency })) === dependencyCode,
            `${token.symbol}: dependency runtime differs`,
          );
          if (name === "beacon") {
            const implementation = (await read(
              dependency,
              parseAbi(["function implementation() view returns (address)"]),
              "implementation",
            )) as Address;
            const implementationCode = await source.getCode({
              address: implementation,
              blockNumber,
            });
            assert(
              implementationCode && implementationCode !== "0x",
              "Missing beacon implementation",
            );
            assert(
              (await local.getCode({ address: implementation })) === implementationCode,
              "Fork beacon implementation differs",
            );
            dependencies.push({
              kind: "beaconImplementation",
              address: implementation,
              runtimeHash: keccak256(implementationCode),
              runtime: implementationCode,
            });
          }
        }
      }
    }
    const holderBalance = await balance(token.address, token.holder);
    const sourceHolderBalance = await source.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [token.holder],
      blockNumber,
    });
    assert(holderBalance === sourceHolderBalance, `${token.symbol}: fork balance differs`);
    const unit = 10n ** BigInt(token.decimals);
    const funding = (token.symbol === "USDG" ? 1000n : 10n) * unit;
    assert(holderBalance >= funding, `${token.symbol}: fixture holder has insufficient funds`);
    identities.push({
      ...token,
      runtime: code,
      slots: storage,
      dependencies,
      name: await read(token.address, erc20Abi, "name"),
      totalSupply: await read(token.address, erc20Abi, "totalSupply"),
      holderBalance,
      sourceHolderBalance,
    });
    await localRpc("anvil_setBalance", [token.holder, toHex(10n ** 18n)]);
    await localRpc("anvil_impersonateAccount", [token.holder]);
    try {
      const simulation = await local.simulateContract({
        account: token.holder,
        address: token.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [account.address, funding],
      });
      assert(simulation.result === true, `${token.symbol}: transfer did not return true`);
      const hash = await createWalletClient({
        account: token.holder,
        transport: http(localUrl),
      }).writeContract({ ...simulation.request, chain: null });
      const receipt = await local.waitForTransactionReceipt({ hash });
      assert(receipt.status === "success", `${token.symbol}: local holder transfer failed`);
      transactions.push({
        functionName: "localHolderFunding",
        symbol: token.symbol,
        from: token.holder,
        to: account.address,
        funding,
        hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      });
    } finally {
      await localRpc("anvil_stopImpersonatingAccount", [token.holder]);
    }
    assert(
      (await balance(token.address, account.address)) === funding,
      `${token.symbol}: non-exact incoming transfer`,
    );
    assert(
      (await balance(token.address, token.holder)) === holderBalance - funding,
      `${token.symbol}: non-exact outgoing transfer`,
    );
    pass(
      `${token.symbol}: exact transfer from real holder, boolean return, unchanged implementation`,
      { decimals, funding },
    );
  }
  await save("token-identities.json", identities);

  const ctfArtifact = await loadConditionalTokensArtifact();
  const ctf = await deploy("ConditionalTokens", ctfArtifact.abi, ctfArtifact.bytecode);
  const positionArtifact = await loadArtifact("PositionRouter");
  const router = await deploy(
    "PositionRouter",
    positionArtifact.abi,
    positionArtifact.bytecode.object,
    [ctf],
  );
  const authorityArtifact = await loadArtifact("ProtocolAuthority");
  const authority = await deploy(
    "ProtocolAuthority",
    authorityArtifact.abi,
    authorityArtifact.bytecode.object,
    Array(4).fill(account.address),
  );
  await runRawRatioForkLifecycle({
    account,
    privateKey: localPrivateKey,
    localUrl,
    ctf,
    router,
    authority,
    quote: tokens[0].address,
    stocks: tokens.slice(1),
    deploy,
    pass,
    save,
    record: (value) => {
      transactions.push(value);
    },
  });
  protocolCompatible = true;

  await write(ctf, ctfArtifact.abi, "setApprovalForAll", [router, true]);
  for (const token of tokens) {
    const unit = 10n ** BigInt(token.decimals);
    assert(
      (await write(token.address, erc20Abi, "approve", [ctf, 100n * unit])) === true,
      "approve did not return true",
    );
    assert(
      (await read(token.address, erc20Abi, "allowance", [account.address, ctf])) === 100n * unit,
      "Incorrect allowance",
    );
    pass(`${token.symbol}: exact approval and boolean return`);
    for (const scenario of ["merge", "yes", "no", "invalid"] as const) {
      const question = keccak256(toHex(`RH_FORK_${token.symbol}_${scenario}`));
      await write(ctf, ctfArtifact.abi, "prepareCondition", [account.address, question, 2n]);
      const condition = (await read(ctf, ctfArtifact.abi, "getConditionId", [
        account.address,
        question,
        2n,
      ])) as Hex;
      const partition = [1n, 2n] as const;
      const positionIds: bigint[] = [];
      for (const index of partition) {
        const collection = await read(ctf, ctfArtifact.abi, "getCollectionId", [
          zeroHash,
          condition,
          index,
        ]);
        positionIds.push(
          (await read(ctf, ctfArtifact.abi, "getPositionId", [
            token.address,
            collection,
          ])) as bigint,
        );
      }
      const amount = 2n * unit;
      const before = await balance(token.address, account.address);
      const lockedBefore = await balance(token.address, ctf);
      await write(ctf, ctfArtifact.abi, "splitPosition", [
        token.address,
        zeroHash,
        condition,
        partition,
        amount,
      ]);
      assert(
        (await balance(token.address, account.address)) === before - amount,
        "Split debit not exact",
      );
      assert(
        (await balance(token.address, ctf)) === lockedBefore + amount,
        "CTF backing not exact",
      );
      for (const id of positionIds)
        assert(
          (await read(ctf, ctfArtifact.abi, "balanceOf", [account.address, id])) === amount,
          "Split claim amount differs",
        );
      if (scenario === "merge") {
        const payout = await write(router, positionArtifact.abi, "mergeForUser", [
          token.address,
          condition,
          amount,
          account.address,
        ]);
        assert(payout === amount, "Merge payout differs");
        assert(
          (await balance(token.address, account.address)) === before,
          "Merge did not restore balance",
        );
      } else {
        const payouts: readonly [bigint, bigint] =
          scenario === "yes" ? [1n, 0n] : scenario === "no" ? [0n, 1n] : [1n, 1n];
        await write(ctf, ctfArtifact.abi, "reportPayouts", [question, payouts]);
        const recipientBefore = await balance(token.address, recipient);
        for (const i of [0, 1] as const) {
          const expected = (amount * payouts[i]) / (payouts[0] + payouts[1]);
          const payout = await write(router, positionArtifact.abi, "redeemForUser", [
            token.address,
            condition,
            [partition[i]],
            [amount],
            recipient,
          ]);
          assert(payout === expected, `${scenario}: branch payout differs`);
        }
        assert(
          (await balance(token.address, recipient)) === recipientBefore + amount,
          "Recipient did not receive total collateral",
        );
      }
      assert(
        (await balance(token.address, ctf)) === lockedBefore,
        "CTF collateral remained after complete exit",
      );
      assert((await balance(token.address, router)) === 0n, "Router retained collateral");
      for (const id of positionIds) {
        assert(
          (await read(ctf, ctfArtifact.abi, "balanceOf", [account.address, id])) === 0n,
          "Unburned user claims",
        );
        assert(
          (await read(ctf, ctfArtifact.abi, "balanceOf", [router, id])) === 0n,
          "Router retained claims",
        );
      }
      pass(`${token.symbol}: real CTF split + ${scenario} exit with exact raw-unit conservation`);
    }
    if (token.symbol !== "USDG") {
      const abi = parseAbi([
        "function uiMultiplier() view returns (uint256)",
        "function balanceOfUI(address) view returns (uint256)",
      ]);
      const multiplier = (await read(token.address, abi, "uiMultiplier")) as bigint;
      const raw = await balance(token.address, recipient);
      const ui = await read(token.address, abi, "balanceOfUI", [recipient]);
      assert(ui === (raw * multiplier) / 10n ** 18n, "UI multiplier differs from raw-unit view");
      pass(`${token.symbol}: current UI multiplier and raw units agree`, {
        multiplier,
        raw,
        ui,
        limitation: "No issuer-admin or scheduled-multiplier changes exercised",
      });
    }
    // A standard EVM fork cannot certify chain-specific compliance/upgrade behavior.
  }
  completed = true;
} catch (error) {
  fatalError = error instanceof Error ? error.message : String(error);
  console.error(fatalError);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await child.exited;
  }
  await childLog;
  proxy.stop(true);
  await save("token-identities.json", identities);
  await save("transactions.json", transactions);
  await save("pinned-read-cache.json", [...pinnedReads]);
  await save("result.json", {
    started,
    finished: new Date().toISOString(),
    completed,
    protocolCompatible,
    point2:
      completed && protocolCompatible
        ? "VERIFIED — pinned Anvil real-token compatibility; not production approval"
        : "NOT VERIFIED — incomplete lifecycle run",
    productionApproved: false,
    liveTransactionsSubmitted: 0,
    source: await sourceManifest(),
    runnerSha256: createHash("sha256")
      .update(await Bun.file(import.meta.path).bytes())
      .digest("hex"),
    blockNumber,
    blockHash,
    sourceChainId: 4663,
    localChainId: 4663,
    checks,
    transactions: transactions.length,
    upstreamReadMethods: methods,
    deniedUpstreamWrites: deniedWrites,
    deniedMethods,
    cachedReadHits,
    pinnedReadCacheEntries: pinnedReads.size,
    fatalError,
    limits: [
      "Token issuer controls, upgrades and scheduled multiplier changes not fully reviewed or tested",
      "RH/Nitro precompiles, sequencer screening and finality not certified by Anvil",
      "M-02 remains open",
      "Case isolation uses local EVM snapshots; recorded case transactions can be orphaned by intentional local reverts",
    ],
  });
  console.log(`Evidence: ${output}`);
}
process.exit(completed && protocolCompatible ? 0 : 1);
