import {
  type Address,
  type createPublicClient,
  encodeDeployData,
  getAddress,
  keccak256,
  parseAbiItem,
  toBytes,
  zeroAddress,
  zeroHash,
} from "viem";
import { INTERNAL_MAINNET_ACK } from "../../config/src/release.ts";
import { createPublicChainClient, loadArtifact, requiredEnvironment, writeOutput } from "./lib.ts";
import {
  assertDevelopmentChain,
  assertRuntime,
  CTF_RUNTIME_HASH,
  type DeploymentRecord,
  roleIds,
  sourceManifest,
} from "./security.ts";

type PublicClient = ReturnType<typeof createPublicClient>;
type Roles = Record<keyof typeof roleIds, Address>;
export const protocolContractNames = [
  "ProtocolAuthority",
  "ProtocolFeeVault",
  "MarketRegistry",
  "ManualResolutionController",
  "ConditionalExchange",
  "PayoutVault",
  "OrderValidator",
  "ConditionalSettlement",
  "AtomicOrderRouter",
  "OrderRecoveryRouter",
  "PositionRouter",
] as const;

export async function verifyWiring(
  client: PublicClient,
  records: Record<string, DeploymentRecord>,
  usdg: Address,
  roles: Roles,
  expectedAdmin: Address,
  deployer: Address,
): Promise<void> {
  const address = (name: string): Address => {
    const entry = records[name];
    if (!entry) throw new Error(`Missing ${name} deployment`);
    return getAddress(entry.address);
  };
  const authority = address("ProtocolAuthority");
  const registry = address("MarketRegistry");
  const exchange = address("ConditionalExchange");
  const ctf = address("ConditionalTokens");
  const registryArtifact = await loadArtifact("MarketRegistry");
  const atomicArtifact = await loadArtifact("AtomicOrderRouter");
  if (
    Number(
      await client.readContract({
        abi: atomicArtifact.abi,
        address: address("AtomicOrderRouter"),
        functionName: "EXECUTION_VERSION",
      }),
    ) !== 2
  )
    throw new Error("Expected checked atomic execution version 2");
  const validatorArtifact = await loadArtifact("OrderValidator");
  const signingVersion = await client.readContract({
    abi: validatorArtifact.abi,
    address: address("OrderValidator"),
    functionName: "VERSION_HASH",
  });
  if (signingVersion !== keccak256(toBytes("3")))
    throw new Error("Expected v3 fee-capped order signatures");
  if (
    Number(
      await client.readContract({
        abi: registryArtifact.abi,
        address: registry,
        functionName: "PROTOCOL_VERSION",
      }),
    ) !== 2
  ) {
    throw new Error("Expected v2 raw-unit ratio registry; do not reuse a v1 deployment");
  }
  const expectations: [string, string, Address][] = [
    ["MarketRegistry", "ctf", ctf],
    ["MarketRegistry", "authority", authority],
    ["MarketRegistry", "quoteToken", usdg],
    ["MarketRegistry", "resolutionController", address("ManualResolutionController")],
    ["ManualResolutionController", "ctf", ctf],
    ["ManualResolutionController", "registry", registry],
    ["ManualResolutionController", "authority", authority],
    ["ConditionalExchange", "conditionalTokens", ctf],
    ["ConditionalExchange", "registry", registry],
    ["ConditionalExchange", "authority", authority],
    ["ConditionalExchange", "settlement", address("ConditionalSettlement")],
    ["ConditionalExchange", "orderValidator", address("OrderValidator")],
    ["ConditionalExchange", "atomicRouter", address("AtomicOrderRouter")],
    ["ConditionalExchange", "payoutVault", address("PayoutVault")],
    ["PayoutVault", "exchange", exchange],
    ["PayoutVault", "conditionalTokens", ctf],
    ["ConditionalSettlement", "exchange", exchange],
    ["ConditionalSettlement", "registry", registry],
    ["ConditionalSettlement", "conditionalTokens", ctf],
    ["ConditionalSettlement", "feeVault", address("ProtocolFeeVault")],
    ["ConditionalSettlement", "payoutVault", address("PayoutVault")],
    ["ProtocolFeeVault", "conditionalTokens", ctf],
    ["ProtocolFeeVault", "authority", authority],
    ["OrderValidator", "exchange", exchange],
    ["AtomicOrderRouter", "exchange", exchange],
    ["AtomicOrderRouter", "authority", authority],
    ["OrderRecoveryRouter", "exchange", exchange],
    ["PositionRouter", "conditionalTokens", ctf],
    ["ProtocolAuthority", "defaultAdmin", expectedAdmin],
  ];
  for (const [name, getter, expected] of expectations) {
    const artifact = await loadArtifact(name);
    const actual = (await client.readContract({
      abi: artifact.abi,
      address: address(name),
      functionName: getter,
    } as never)) as Address;
    if (getAddress(actual) !== getAddress(expected)) throw new Error(`${name}.${getter} mismatch`);
  }
  const artifact = await loadArtifact("ProtocolAuthority");
  const delay = (await client.readContract({
    abi: artifact.abi,
    address: authority,
    functionName: "defaultAdminDelay",
  })) as number;
  if (BigInt(delay) < 172800n) throw new Error("Default-admin delay is shorter than two days");
  const [pendingDelay, delaySchedule] = (await client.readContract({
    abi: artifact.abi,
    address: authority,
    functionName: "pendingDefaultAdminDelay",
  })) as [number, number];
  if (BigInt(delaySchedule) !== 0n && BigInt(pendingDelay) < 172800n)
    throw new Error("Scheduled default-admin delay is shorter than two days");
  const roleAccounts = (Object.keys(roleIds) as (keyof Roles)[]).map((name) => roles[name]);
  const accounts = new Set(
    [deployer, expectedAdmin, ...roleAccounts].map((value) => getAddress(value)),
  );
  const authorityBlock = records.ProtocolAuthority?.blockNumber;
  if (!authorityBlock)
    throw new Error("Missing authority deployment block for role reconciliation");
  // AccessControl is not enumerable. Include every historically granted account, then
  // query its current membership so grants to addresses outside the manifest cannot hide.
  const range = BigInt(Bun.env.INDEXER_GET_LOGS_BLOCK_RANGE ?? "2000");
  if (range < 1n || range > 100_000n) throw new Error("Invalid role verification log range");
  const head = await client.getBlockNumber({ cacheTime: 0 });
  for (let fromBlock = BigInt(authorityBlock); fromBlock <= head; fromBlock += range) {
    const end = fromBlock + range - 1n;
    const grants = await client.getLogs({
      address: authority,
      event: parseAbiItem(
        "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
      ),
      fromBlock,
      toBlock: end < head ? end : head,
      strict: true,
    });
    for (const grant of grants) accounts.add(getAddress(grant.args.account));
  }
  const expectedRoles = { ...roles, defaultAdmin: expectedAdmin };
  for (const [name, role] of Object.entries({ ...roleIds, defaultAdmin: zeroHash })) {
    for (const account of accounts) {
      const actual = (await client.readContract({
        abi: artifact.abi,
        address: authority,
        functionName: "hasRole",
        args: [role, account],
      })) as boolean;
      if (actual !== (account === getAddress(expectedRoles[name as keyof typeof expectedRoles])))
        throw new Error(`Unexpected ${name} role membership for ${account}`);
    }
  }
  if (getAddress(deployer) !== getAddress(expectedAdmin)) {
    const retained = (await client.readContract({
      abi: artifact.abi,
      address: authority,
      functionName: "hasRole",
      args: [zeroHash, deployer],
    })) as boolean;
    if (retained) throw new Error("Deployer still has default administration");
  }
}

export interface DeploymentManifest {
  productionApproved?: false;
  release?: { mode: string; productionApproved: false; riskAcknowledgement?: string };
  protocolVersion: 2;
  executionVersion: 2;
  priceFormat: "raw-unit-ratio-x18";
  chainId: number;
  deployer: Address;
  deployments: Record<string, DeploymentRecord>;
  usdg: Address;
  source: Awaited<ReturnType<typeof sourceManifest>>;
  roles: Roles & { finalDefaultAdmin: Address };
}

/** Read-only release check; never signs, changes roles, or creates a market. */
export async function verifyDeploymentManifest(
  client: PublicClient,
  manifest: DeploymentManifest,
): Promise<void> {
  assertDevelopmentChain(manifest.chainId);
  if (
    manifest.chainId === 4663 &&
    (manifest.productionApproved !== false ||
      manifest.release?.mode !== "internal-mainnet" ||
      manifest.release.productionApproved !== false ||
      manifest.release.riskAcknowledgement !== INTERNAL_MAINNET_ACK)
  )
    throw new Error(
      "Mainnet manifest must retain explicit experimental risk acknowledgement and productionApproved=false",
    );
  if (
    manifest.protocolVersion !== 2 ||
    manifest.executionVersion !== 2 ||
    manifest.priceFormat !== "raw-unit-ratio-x18"
  )
    throw new Error("Legacy manifest requires a fresh atomic-execution deployment");
  if ((await client.getChainId()) !== manifest.chainId) throw new Error("Manifest chain mismatch");
  const currentSource = await sourceManifest();
  if (
    manifest.source.digest !== currentSource.digest ||
    manifest.source.lockSha256 !== currentSource.lockSha256
  ) {
    throw new Error("Manifest does not match the current source and dependency lock");
  }
  const ctf = manifest.deployments.ConditionalTokens;
  if (!ctf) throw new Error("Missing ConditionalTokens deployment");
  assertRuntime(
    await client.getBytecode({ address: ctf.address }),
    CTF_RUNTIME_HASH,
    "ConditionalTokens",
  );
  for (const name of protocolContractNames) {
    const record = manifest.deployments[name];
    if (!record?.constructorArgs || !record.transactionHash || !record.blockHash)
      throw new Error(`Missing ${name} deployment evidence`);
    const artifact = await loadArtifact(name);
    const initcode = encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: record.constructorArgs,
    } as never);
    if (keccak256(initcode) !== record.initcodeHash)
      throw new Error(`${name} constructor arguments differ from manifest`);
    const parent = name === "PayoutVault" ? manifest.deployments.ConditionalExchange : undefined;
    if (
      name === "PayoutVault" &&
      (!parent ||
        record.creator?.toLowerCase() !== parent.address.toLowerCase() ||
        record.transactionHash !== parent.transactionHash ||
        record.blockHash !== parent.blockHash)
    )
      throw new Error("PayoutVault must be created by the recorded exchange deployment");
    if (name !== "PayoutVault" && record.creator !== undefined)
      throw new Error(`Unexpected ${name} creator`);
    const expected = await client.call({
      account: parent?.address ?? manifest.deployer,
      data: initcode,
    });
    if (!expected.data || expected.data === "0x")
      throw new Error(`${name} reference deployment returned no runtime`);
    const runtime = await client.getBytecode({ address: record.address });
    assertRuntime(runtime, keccak256(expected.data), name);
    assertRuntime(runtime, record.bytecodeHash, name);
    const receipt = await client.getTransactionReceipt({ hash: record.transactionHash });
    const transaction = await client.getTransaction({ hash: record.transactionHash });
    if (
      receipt.status !== "success" ||
      receipt.blockHash !== record.blockHash ||
      receipt.blockNumber.toString() !== record.blockNumber ||
      receipt.contractAddress?.toLowerCase() !==
        (parent?.address ?? record.address).toLowerCase() ||
      (!parent && transaction.input !== initcode) ||
      getAddress(transaction.from) !== getAddress(manifest.deployer)
    )
      throw new Error(`${name} deployment receipt/transaction mismatch`);
  }
  await verifyWiring(
    client,
    manifest.deployments,
    manifest.usdg,
    manifest.roles,
    manifest.roles.finalDefaultAdmin,
    manifest.deployer,
  );
  const artifact = await loadArtifact("ProtocolAuthority");
  const authority = manifest.deployments.ProtocolAuthority;
  if (!authority) throw new Error("Missing ProtocolAuthority");
  const [pending, schedule] = (await client.readContract({
    abi: artifact.abi,
    address: authority.address,
    functionName: "pendingDefaultAdmin",
  })) as [Address, number];
  if (getAddress(pending) !== zeroAddress || BigInt(schedule) !== 0n)
    throw new Error("Admin handover is not complete");
}

if (import.meta.main) {
  const { publicClient } = await createPublicChainClient();
  const manifest = (await Bun.file(
    requiredEnvironment("DEPLOYMENT_MANIFEST"),
  ).json()) as DeploymentManifest;
  await verifyDeploymentManifest(publicClient, manifest);
  writeOutput({
    verified: true,
    productionApproved: false,
    chainId: manifest.chainId,
    sourceDigest: manifest.source.digest,
  });
}
