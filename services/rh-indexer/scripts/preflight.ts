import {
  atomicOrderRouterAbi,
  conditionalExchangeAbi,
  conditionalSettlementAbi,
  manualResolutionControllerAbi,
  marketRegistryAbi,
  orderRecoveryRouterAbi,
  payoutVaultAbi,
  positionRouterAbi,
} from "@conditional-stocks/contract-bindings";
import { type Address, createPublicClient, getAddress, http, keccak256 } from "viem";

import { loadIndexerEnvironment } from "../src/environment.ts";

const environment = loadIndexerEnvironment(process.env);
if (environment.finalityMode === "local-depth" && environment.chainId !== 31337) {
  const probe = createPublicClient({ transport: http(environment.rpcUrls[0]) });
  const version = await probe.request({ method: "web3_clientVersion" });
  if (!version.toLowerCase().includes("anvil"))
    throw new Error("local-depth finality is permitted only on Anvil; use rpc-tags on RH");
}
const client = createPublicClient({ transport: http(environment.rpcUrls[0]) });
const actualChainId = await client.getChainId();
const protocolVersion = await client.readContract({
  abi: marketRegistryAbi,
  address: environment.contracts.marketRegistry,
  functionName: "PROTOCOL_VERSION",
});
if (protocolVersion !== 2) throw new Error("Indexer requires a fresh v2 raw-unit ratio deployment");
if (actualChainId !== environment.chainId) {
  throw new Error(`wrong RPC chain: expected ${environment.chainId}, received ${actualChainId}`);
}

// The router emits no projection events, so it is verified here rather than added
// as an unnecessary Ponder event source.
const atomicRouter = await client.readContract({
  abi: conditionalExchangeAbi,
  address: environment.contracts.exchange,
  functionName: "atomicRouter",
});
if (
  process.env.ATOMIC_ORDER_ROUTER_ADDRESS &&
  getAddress(process.env.ATOMIC_ORDER_ROUTER_ADDRESS) !== getAddress(atomicRouter)
)
  throw new Error("Atomic router differs from the configured deployment");
const [executionVersion, routerExchange, routerAuthority] = await Promise.all([
  client.readContract({
    abi: atomicOrderRouterAbi,
    address: atomicRouter,
    functionName: "EXECUTION_VERSION",
  }),
  client.readContract({
    abi: atomicOrderRouterAbi,
    address: atomicRouter,
    functionName: "exchange",
  }),
  client.readContract({
    abi: atomicOrderRouterAbi,
    address: atomicRouter,
    functionName: "authority",
  }),
]);
if (
  executionVersion !== 2n ||
  getAddress(routerExchange) !== getAddress(environment.contracts.exchange) ||
  getAddress(routerAuthority) !== getAddress(environment.contracts.protocolAuthority)
)
  throw new Error("Expected correctly wired permissionless atomic execution version 2");

const head = await client.getBlockNumber();
if (BigInt(environment.deploymentBlock) > head) {
  throw new Error(`DEPLOYMENT_BLOCK ${environment.deploymentBlock} is above chain head ${head}`);
}
if (
  environment.endBlock !== undefined &&
  (environment.endBlock < environment.deploymentBlock || BigInt(environment.endBlock) > head)
) {
  throw new Error(
    `INDEXER_END_BLOCK ${environment.endBlock} must be between deployment block ${environment.deploymentBlock} and chain head ${head}`,
  );
}

const entries = Object.entries(environment.contracts) as Array<
  [keyof typeof environment.contracts, Address]
>;
const codes = new Map<string, `0x${string}`>();
await Promise.all(
  entries.map(async ([name, address]) => {
    const code = await client.getBytecode({ address });
    if (!code || code === "0x") throw new Error(`${name} has no contract code at ${address}`);
    codes.set(name, code);
  }),
);

const checks = await Promise.all([
  client.readContract({
    abi: conditionalExchangeAbi,
    address: environment.contracts.exchange,
    functionName: "payoutVault",
  }),
  client.readContract({
    abi: conditionalSettlementAbi,
    address: environment.contracts.settlement,
    functionName: "payoutVault",
  }),
  client.readContract({
    abi: payoutVaultAbi,
    address: environment.contracts.payoutVault,
    functionName: "exchange",
  }),
  client.readContract({
    abi: payoutVaultAbi,
    address: environment.contracts.payoutVault,
    functionName: "conditionalTokens",
  }),
  client.readContract({
    abi: marketRegistryAbi,
    address: environment.contracts.marketRegistry,
    functionName: "ctf",
  }),
  client.readContract({
    abi: conditionalExchangeAbi,
    address: environment.contracts.exchange,
    functionName: "conditionalTokens",
  }),
  client.readContract({
    abi: conditionalExchangeAbi,
    address: environment.contracts.exchange,
    functionName: "registry",
  }),
  client.readContract({
    abi: conditionalExchangeAbi,
    address: environment.contracts.exchange,
    functionName: "settlement",
  }),
  client.readContract({
    abi: conditionalSettlementAbi,
    address: environment.contracts.settlement,
    functionName: "exchange",
  }),
  client.readContract({
    abi: conditionalSettlementAbi,
    address: environment.contracts.settlement,
    functionName: "registry",
  }),
  client.readContract({
    abi: manualResolutionControllerAbi,
    address: environment.contracts.resolutionController,
    functionName: "ctf",
  }),
  client.readContract({
    abi: manualResolutionControllerAbi,
    address: environment.contracts.resolutionController,
    functionName: "registry",
  }),
  client.readContract({
    abi: positionRouterAbi,
    address: environment.contracts.positionRouter,
    functionName: "conditionalTokens",
  }),
  client.readContract({
    abi: orderRecoveryRouterAbi,
    address: environment.contracts.orderRecoveryRouter,
    functionName: "exchange",
  }),
]);

const expected = [
  environment.contracts.payoutVault,
  environment.contracts.payoutVault,
  environment.contracts.exchange,
  environment.contracts.conditionalTokens,
  environment.contracts.conditionalTokens,
  environment.contracts.conditionalTokens,
  environment.contracts.marketRegistry,
  environment.contracts.settlement,
  environment.contracts.exchange,
  environment.contracts.marketRegistry,
  environment.contracts.conditionalTokens,
  environment.contracts.marketRegistry,
  environment.contracts.conditionalTokens,
  environment.contracts.exchange,
].map((value) => getAddress(value));

for (let index = 0; index < checks.length; index += 1) {
  const actual = checks[index];
  if (typeof actual !== "string" || getAddress(actual) !== expected[index]) {
    throw new Error(`contract dependency check ${index} failed`);
  }
}

const manifestPath = process.env.INDEXER_DEPLOYMENT_MANIFEST;
if (manifestPath) {
  const manifest = (await Bun.file(manifestPath).json()) as {
    chainId?: number;
    deployments?: Record<string, { address?: Address; bytecodeHash?: `0x${string}` }>;
  };
  if (manifest.chainId !== environment.chainId || !manifest.deployments) {
    throw new Error("deployment manifest chain or deployments are invalid");
  }
  const manifestNames: Record<keyof typeof environment.contracts, string> = {
    conditionalTokens: "ConditionalTokens",
    exchange: "ConditionalExchange",
    marketRegistry: "MarketRegistry",
    orderRecoveryRouter: "OrderRecoveryRouter",
    positionRouter: "PositionRouter",
    protocolAuthority: "ProtocolAuthority",
    resolutionController: "ManualResolutionController",
    settlement: "ConditionalSettlement",
    payoutVault: "PayoutVault",
  };
  for (const [name, address] of entries) {
    const deployment = manifest.deployments[manifestNames[name]];
    if (!deployment?.address || getAddress(deployment.address) !== getAddress(address)) {
      throw new Error(`${name} does not match deployment manifest`);
    }
    const code = codes.get(name);
    if (deployment.bytecodeHash && code && keccak256(code) !== deployment.bytecodeHash) {
      throw new Error(`${name} bytecode hash does not match deployment manifest`);
    }
  }
}

process.stdout.write(
  `Indexer preflight passed for chain ${environment.chainId} at block ${head.toString()}\n`,
);
