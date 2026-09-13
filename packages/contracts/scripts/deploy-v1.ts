import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Abi,
  type Address,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  keccak256,
} from "viem";
import { releasePolicy } from "../../config/src/release.ts";
import { deploymentRecovery } from "./deployment-recovery.ts";
import {
  assertContract,
  createChainClients,
  environmentAddress,
  loadArtifact,
  loadConditionalTokensArtifact,
  writeOutput,
} from "./lib.ts";
import {
  assertDeploymentRoles,
  assertDevelopmentChain,
  assertRuntime,
  CTF_RUNTIME_HASH,
  type DeploymentRecord,
  sourceManifest,
} from "./security.ts";
import { verifyWiring } from "./verify-deployment.ts";

const { account, chain, chainId, publicClient, walletClient } =
  await createChainClients("DEPLOYER_PRIVATE_KEY");
assertDevelopmentChain(chainId);
const initialAdmin = environmentAddress("INITIAL_ADMIN");
if (initialAdmin !== getAddress(account.address)) {
  throw new Error("INITIAL_ADMIN must equal the deployment account for atomic configuration");
}
const finalAdmin = environmentAddress("FINAL_ADMIN");
const roleAddresses = {
  guardian: environmentAddress("GUARDIAN"),
  marketAdmin: environmentAddress("MARKET_ADMIN"),
  resolutionAdmin: environmentAddress("RESOLUTION_ADMIN"),
} as const;
assertDeploymentRoles(initialAdmin, finalAdmin, roleAddresses);
const recovery = await deploymentRecovery(
  publicClient,
  account.address,
  chainId,
  Bun.env.DEPLOYMENT_RESUME_JOURNAL,
);

const deployments: Record<string, DeploymentRecord> = {};

const deploy = async (
  contractName: string,
  abi: Abi,
  bytecode: Hex,
  args: readonly unknown[] = [],
): Promise<Address> => {
  const initcode = encodeDeployData({ abi, bytecode, args } as never);
  const blockNumber = await recovery.referenceBlock();
  const expected = await publicClient.call({
    account: account.address,
    data: initcode,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (!expected.data || expected.data === "0x")
    throw new Error(`${contractName} reference deployment returned no runtime`);
  const hash = await recovery.send(initcode, null, () =>
    walletClient.deployContract({
      abi,
      account,
      args,
      bytecode,
      chain,
    } as never),
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${contractName} deployment failed: ${hash}`);
  }
  const address = getAddress(receipt.contractAddress);
  const installedBytecode = await publicClient.getBytecode({ address });
  const bytecodeHash = assertRuntime(installedBytecode, keccak256(expected.data), contractName);
  deployments[contractName] = {
    address,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    bytecodeHash,
    constructorArgs: args,
    initcodeHash: keccak256(initcode),
    transactionHash: hash,
  };
  return address;
};

const deployFoundry = async (
  contractName: string,
  args: readonly unknown[] = [],
): Promise<Address> => {
  const artifact = await loadArtifact(contractName);
  return deploy(contractName, artifact.abi, artifact.bytecode.object, args);
};

let conditionalTokens: Address;
if (Bun.env.DEPLOY_CONDITIONAL_TOKENS === "true") {
  const artifact = await loadConditionalTokensArtifact();
  conditionalTokens = await deploy("ConditionalTokens", artifact.abi, artifact.bytecode, []);
} else {
  conditionalTokens = environmentAddress("CONDITIONAL_TOKENS_ADDRESS");
  const deployedBytecode = await publicClient.getBytecode({ address: conditionalTokens });
  deployments.ConditionalTokens = {
    address: conditionalTokens,
    bytecodeHash: assertRuntime(deployedBytecode, CTF_RUNTIME_HASH, "ConditionalTokens"),
  };
}
assertRuntime(
  await publicClient.getBytecode({ address: conditionalTokens }),
  CTF_RUNTIME_HASH,
  "ConditionalTokens",
);

const usdg = environmentAddress("USDG_ADDRESS");
await assertContract(publicClient, usdg, "USDG");

const authority = await deployFoundry("ProtocolAuthority", [
  initialAdmin,
  roleAddresses.marketAdmin,
  roleAddresses.guardian,
  roleAddresses.resolutionAdmin,
]);
const registry = await deployFoundry("MarketRegistry", [conditionalTokens, authority, usdg]);
const resolutionController = await deployFoundry("ManualResolutionController", [
  conditionalTokens,
  registry,
  authority,
]);
const exchange = await deployFoundry("ConditionalExchange", [
  conditionalTokens,
  registry,
  authority,
]);
const orderValidator = await deployFoundry("OrderValidator", [exchange]);
const payoutArtifact = await loadArtifact("PayoutVault");
const payoutAddress = getAddress(
  (await publicClient.readContract({
    abi: (await loadArtifact("ConditionalExchange")).abi,
    address: exchange,
    functionName: "payoutVault",
  })) as Address,
);
const payoutInitcode = encodeDeployData({
  abi: payoutArtifact.abi,
  bytecode: payoutArtifact.bytecode.object,
  args: [conditionalTokens],
} as never);
const payoutReference = await publicClient.call({ account: exchange, data: payoutInitcode });
if (!payoutReference.data || payoutReference.data === "0x")
  throw new Error("Missing payout vault reference runtime");
const exchangeRecord = deployments.ConditionalExchange;
if (!exchangeRecord?.blockNumber || !exchangeRecord.blockHash || !exchangeRecord.transactionHash)
  throw new Error("Missing exchange creation evidence");
deployments.PayoutVault = {
  address: payoutAddress,
  creator: exchange,
  constructorArgs: [conditionalTokens],
  blockNumber: exchangeRecord.blockNumber,
  blockHash: exchangeRecord.blockHash,
  transactionHash: exchangeRecord.transactionHash,
  initcodeHash: keccak256(payoutInitcode),
  bytecodeHash: assertRuntime(
    await publicClient.getBytecode({ address: payoutAddress }),
    keccak256(payoutReference.data),
    "PayoutVault",
  ),
};
const feeVault = await deployFoundry("ProtocolFeeVault", [conditionalTokens, authority]);
const settlement = await deployFoundry("ConditionalSettlement", [
  conditionalTokens,
  registry,
  exchange,
  feeVault,
]);
const atomicRouter = await deployFoundry("AtomicOrderRouter", [exchange, authority]);
await deployFoundry("OrderRecoveryRouter", [exchange]);
await deployFoundry("PositionRouter", [conditionalTokens]);

const registryArtifact = await loadArtifact("MarketRegistry");
const exchangeArtifact = await loadArtifact("ConditionalExchange");
const authorityArtifact = await loadArtifact("ProtocolAuthority");
const configurationReceipts: {
  label: string;
  transactionHash: Hash;
  blockNumber: string;
  blockHash: Hash;
}[] = [];
const configure = async (
  label: string,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<Hash> => {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const hash = await recovery.send(data, address, () =>
    walletClient.writeContract({
      abi,
      account,
      address,
      args,
      chain,
      functionName,
    } as never),
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  configurationReceipts.push({
    label,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
  });
  return hash;
};

await configure(
  "setResolutionController",
  registry,
  registryArtifact.abi,
  "setResolutionController",
  [resolutionController],
);
await configure(
  "configureOrderValidator",
  exchange,
  exchangeArtifact.abi,
  "configureOrderValidator",
  [orderValidator],
);
await configure("configureSettlement", exchange, exchangeArtifact.abi, "configureSettlement", [
  settlement,
]);
await configure("configureAtomicRouter", exchange, exchangeArtifact.abi, "configureAtomicRouter", [
  atomicRouter,
]);
await verifyWiring(publicClient, deployments, usdg, roleAddresses, initialAdmin, initialAdmin);
const adminTransferTransactionHash = await configure(
  "beginDefaultAdminTransfer",
  authority,
  authorityArtifact.abi,
  "beginDefaultAdminTransfer",
  [finalAdmin],
);
const [pendingDefaultAdmin, pendingDefaultAdminAcceptAfter] = (await publicClient.readContract({
  abi: authorityArtifact.abi,
  address: authority,
  functionName: "pendingDefaultAdmin",
})) as readonly [Address, bigint];
if (pendingDefaultAdmin !== finalAdmin || pendingDefaultAdminAcceptAfter === 0n) {
  throw new Error("Default-admin transfer was not scheduled correctly");
}

const latestBlock = (await publicClient.getBlock({ blockTag: "latest" })).number;
recovery.assertConsumed();
const manifest = {
  release: releasePolicy(chainId, Bun.env),
  protocolVersion: 2,
  executionVersion: 2,
  priceFormat: "raw-unit-ratio-x18",
  chainId,
  deployer: initialAdmin,
  source: await sourceManifest(),
  productionApproved: false,
  releaseBlockers: [
    "M-02: independent cryptographic clearance required",
    "Final admin must accept the delayed handover before market creation",
  ],
  configurationReceipts,
  compiler: {
    bytecodeHash: "none",
    evmVersion: "paris",
    optimizerRuns: 7_500,
    solc: "0.8.30",
    viaIr: true,
  },
  deployedAtBlock: latestBlock.toString(),
  deployments,
  roles: {
    currentDefaultAdmin: initialAdmin,
    finalDefaultAdmin: finalAdmin,
    pendingDefaultAdmin: finalAdmin,
    pendingDefaultAdminAcceptAfter: pendingDefaultAdminAcceptAfter.toString(),
    pendingDefaultAdminTransferTransactionHash: adminTransferTransactionHash,
    ...roleAddresses,
  },
  rpcUrl: "redacted",
  usdg,
};
const outputDirectory = Bun.env.DEPLOYMENT_OUTPUT_DIRECTORY
  ? resolve(Bun.env.DEPLOYMENT_OUTPUT_DIRECTORY)
  : resolve(import.meta.dir, `../deployments/${chainId}`);
await mkdir(outputDirectory, { recursive: true });
// Preserve historical deployments; a fresh run cannot overwrite the previous manifest.
const outputPath = resolve(outputDirectory, `v2-${authority.toLowerCase()}.json`);
if (await Bun.file(outputPath).exists()) throw new Error(`Manifest already exists: ${outputPath}`);
await Bun.write(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeOutput(manifest);
