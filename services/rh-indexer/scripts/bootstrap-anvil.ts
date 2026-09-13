import { resolve } from "node:path";
import {
  createDatabase,
  databaseUrl,
  loadDatabaseOptions,
} from "@conditional-stocks/db/connection";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  keccak256,
  toBytes,
  toHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const root = resolve(import.meta.dir, "../../..");
const connectionString = databaseUrl(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname))
  throw new Error("Anvil bootstrap requires an isolated loopback PostgreSQL DATABASE_URL");
const rpcUrl = process.env.ROBINHOOD_RPC_URL ?? "http://127.0.0.1:8545";
const chainId = Number(process.env.ROBINHOOD_CHAIN_ID ?? "31337");
const mnemonic =
  process.env.ANVIL_MNEMONIC ?? "test test test test test test test test test test test junk";
const publicClient = createPublicClient({ transport: http(rpcUrl) });
const actualChainId = await publicClient.getChainId();
if (
  actualChainId !== 31337 ||
  chainId !== 31337 ||
  !(await publicClient.request({ method: "web3_clientVersion" })).toLowerCase().includes("anvil")
)
  throw new Error(
    "Bootstrap is restricted to Anvil chain 31337; never use public development keys on RH",
  );
if (actualChainId !== chainId) {
  throw new Error(`Anvil chain mismatch: expected ${chainId}, received ${actualChainId}`);
}

const accounts = Array.from({ length: 7 }, (_, addressIndex) =>
  mnemonicToAccount(mnemonic, { addressIndex }),
);
const privateKey = (index: number): Hex => {
  const bytes = accounts[index]?.getHdKey().privateKey;
  if (!bytes) throw new Error(`could not derive Anvil private key ${index}`);
  return toHex(bytes);
};
const deployer = accounts[0];
if (!deployer) throw new Error("missing Anvil deployer");
const walletClient = createWalletClient({ account: deployer, transport: http(rpcUrl) });

const mockArtifact = (await Bun.file(
  resolve(root, "packages/contracts/out/MockTokens.sol/MockERC20.json"),
).json()) as {
  abi: readonly unknown[];
  bytecode: { object: Hex };
};
const deployMock = async (name: string, symbol: string): Promise<Address> => {
  const artifact =
    symbol === "USDG"
      ? ((await Bun.file(
          resolve(root, "packages/contracts/out/MockTokens.sol/SixDecimalToken.json"),
        ).json()) as typeof mockArtifact)
      : mockArtifact;
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: symbol === "USDG" ? [] : [name, symbol],
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`failed to deploy ${symbol}`);
  }
  return getAddress(receipt.contractAddress);
};

const usdg = await deployMock("Mock USDG", "USDG");
const stock = await deployMock("Mock Stock", "STOCK");
const roleAddresses = accounts.map((account) => getAddress(account.address));
const deploymentEnvironment = {
  ...process.env,
  DEPLOY_CONDITIONAL_TOKENS: "true",
  DEPLOYER_PRIVATE_KEY: privateKey(0),
  EXPECTED_CHAIN_ID: String(chainId),
  FINAL_ADMIN: roleAddresses[1],
  GUARDIAN: roleAddresses[4],
  INITIAL_ADMIN: roleAddresses[0],
  MARKET_ADMIN: roleAddresses[2],
  RESOLUTION_ADMIN: roleAddresses[2],
  ROBINHOOD_RPC_URL: rpcUrl,
  USDG_ADDRESS: usdg,
};
const deployment = Bun.spawn({
  cmd: ["bun", "packages/contracts/scripts/deploy-v1.ts"],
  cwd: root,
  env: deploymentEnvironment,
  stderr: "inherit",
  stdout: "pipe",
});
const manifestText = await new Response(deployment.stdout).text();
if ((await deployment.exited) !== 0) throw new Error("v2 contract deployment failed");
const manifest = JSON.parse(manifestText) as {
  deployments: Record<string, { address: Address; blockNumber?: string }>;
};
const deploymentAddress = (name: string): Address => {
  const address = manifest.deployments[name]?.address;
  if (!address) throw new Error(`manifest is missing ${name}`);
  return getAddress(address);
};
const manifestPath = resolve(
  process.env.DEPLOYMENT_OUTPUT_DIRECTORY ??
    resolve(root, `packages/contracts/deployments/${chainId}`),
  `v2-${deploymentAddress("ProtocolAuthority").toLowerCase()}.json`,
);
const deploymentBlock = Math.min(
  ...Object.values(manifest.deployments)
    .map((record) => record.blockNumber)
    .filter((value): value is string => value !== undefined)
    .map(Number),
);

const registryArtifact = (await Bun.file(
  resolve(root, "packages/contracts/out/MarketRegistry.sol/MarketRegistry.json"),
).json()) as { abi: readonly unknown[] };
const marketAdmin = accounts[2];
if (!marketAdmin) throw new Error("missing market administrator");
const marketWallet = createWalletClient({ account: marketAdmin, transport: http(rpcUrl) });
const latest = await publicClient.getBlock();
const metadataUri = "ipfs://conditional-stocks-anvil-market-v1";
const marketConfig = {
  baseStep: 10n ** 18n,
  baseToken: stock,
  maxMarketOpenNotional: 1_000_000n * 10n ** 6n,
  maxOrderNotional: 100_000n * 10n ** 6n,
  maxOrderQuantity: 10_000n * 10n ** 18n,
  maxWalletOpenNotional: 250_000n * 10n ** 6n,
  metadataHash: keccak256(toBytes(metadataUri)),
  minNotional: 1n * 10n ** 6n,
  polymarketConditionId: keccak256(toBytes("anvil-polymarket-condition")),
  polymarketNoIndex: 2n,
  polymarketYesIndex: 1n,
  priceTickRawX18: 10_000n,
  quoteToken: usdg,
  rulesHash: keccak256(toBytes("anvil-v1-rules")),
  tradingCutoff: latest.timestamp + 7n * 24n * 60n * 60n,
  tradingOpen: latest.timestamp,
};
const registry = deploymentAddress("MarketRegistry");
const marketId = (await publicClient.readContract({
  abi: registryArtifact.abi,
  address: registry,
  args: [marketConfig],
  functionName: "computeMarketId",
} as never)) as Hex;
const createHash = await marketWallet.writeContract({
  abi: registryArtifact.abi,
  address: registry,
  args: [marketConfig, metadataUri],
  functionName: "createMarket",
} as never);
await publicClient.waitForTransactionReceipt({ hash: createHash });
const openHash = await marketWallet.writeContract({
  abi: registryArtifact.abi,
  address: registry,
  args: [marketId],
  functionName: "openMarket",
} as never);
await publicClient.waitForTransactionReceipt({ hash: openHash });

const envFile = process.env.ANVIL_ENV_OUTPUT ?? resolve(import.meta.dir, "../.env.anvil");
const variables: Record<string, string> = {
  ADMIN_EVIDENCE_PUBLIC_BASE_URL: "https://evidence.local.test/v1/attachments",
  MARKET_ADMIN: roleAddresses[2] ?? "",
  RESOLUTION_ADMIN: roleAddresses[2] ?? "",
  API_AUTH_DOMAIN: "127.0.0.1:3000",
  API_AUTH_ORIGIN: "http://127.0.0.1:3000",
  CONDITIONAL_TOKENS_ADDRESS: deploymentAddress("ConditionalTokens"),
  DATABASE_URL: connectionString,
  DATABASE_SCHEMA: "anvil_atomic_v1",
  DEPLOYMENT_BLOCK: String(deploymentBlock),
  EXCHANGE_ADDRESS: deploymentAddress("ConditionalExchange"),
  INDEXER_CONFIRMATION_BLOCKS: "1",
  INDEXER_DEPLOYMENT_MANIFEST: manifestPath,
  INDEXER_FINALITY_BLOCKS: "5",
  INDEXER_FINALITY_MODE: "local-depth",
  INDEXER_CONFIRMATION_MODE: "sequencer-depth",
  INDEXER_URL: "http://127.0.0.1:42069",
  ATOMIC_ORDER_ROUTER_ADDRESS: deploymentAddress("AtomicOrderRouter"),
  PAYOUT_VAULT_ADDRESS: deploymentAddress("PayoutVault"),
  MARKET_REGISTRY_ADDRESS: deploymentAddress("MarketRegistry"),
  MARKET_ID: marketId,
  ORDER_RECOVERY_ROUTER_ADDRESS: deploymentAddress("OrderRecoveryRouter"),
  PONDER_DISABLE_CACHE: "true",
  POSITION_ROUTER_ADDRESS: deploymentAddress("PositionRouter"),
  POLYMARKET_HOST: "127.0.0.1",
  POLYMARKET_INGESTOR_URL: "http://127.0.0.1:42073",
  POLYMARKET_INTERNAL_TOKEN: "anvil-only-polymarket-token-change-me",
  POLYMARKET_PORT: "42073",
  PROTOCOL_AUTHORITY_ADDRESS: deploymentAddress("ProtocolAuthority"),
  RECONCILIATION_EXCLUSIVE_CTF: "true",
  RECONCILIATION_URL: "http://127.0.0.1:42070",
  RESOLUTION_CONTROLLER_ADDRESS: deploymentAddress("ManualResolutionController"),
  ROBINHOOD_CHAIN_ID: String(chainId),
  ROBINHOOD_RPC_URL: rpcUrl,
  SETTLEMENT_ADDRESS: deploymentAddress("ConditionalSettlement"),
  STOCK_ADDRESS: stock,
  USDG_ADDRESS: usdg,
};
const database = createDatabase(loadDatabaseOptions(variables, "probabl-anvil-bootstrap"));
try {
  await database.migrate();
} finally {
  await database.close();
}
await Bun.write(
  envFile,
  `${Object.entries(variables)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`,
);

process.stdout.write(
  `\nAnvil protocol ready.\nMarket: ${marketId}\nEnvironment: ${envFile}\n` +
    `Run: bun run dev:indexer:anvil\n`,
);
