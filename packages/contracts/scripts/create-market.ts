import { encodeFunctionData, getAddress, type Hex, keccak256, toBytes } from "viem";
import { validateMarketCaps } from "../../domain/src/market-config.ts";
import {
  createChainClients,
  createPublicChainClient,
  environmentAddress,
  environmentBigInt,
  environmentHex32,
  loadArtifact,
  requiredEnvironment,
  writeOutput,
} from "./lib.ts";
import { type DeploymentManifest, verifyDeploymentManifest } from "./verify-deployment.ts";

const checkedUint = (name: string, bits: number): bigint => {
  const value = environmentBigInt(name);
  if (value >= 1n << BigInt(bits)) throw new Error(`${name} exceeds uint${bits}`);
  return value;
};

const registry = environmentAddress("MARKET_REGISTRY_ADDRESS");
const adminCaller = environmentAddress("ADMIN_CALLER_ADDRESS");
const metadataUri = requiredEnvironment("METADATA_URI");
const config = {
  baseStep: checkedUint("BASE_STEP", 128),
  baseToken: environmentAddress("BASE_TOKEN_ADDRESS"),
  maxMarketOpenNotional: checkedUint("MAX_MARKET_OPEN_NOTIONAL", 128),
  maxOrderNotional: checkedUint("MAX_ORDER_NOTIONAL", 128),
  maxOrderQuantity: checkedUint("MAX_ORDER_QUANTITY", 128),
  maxWalletOpenNotional: checkedUint("MAX_WALLET_OPEN_NOTIONAL", 128),
  metadataHash: keccak256(toBytes(metadataUri)),
  minNotional: checkedUint("MIN_NOTIONAL", 128),
  polymarketConditionId: environmentHex32("POLYMARKET_CONDITION_ID"),
  polymarketNoIndex: environmentBigInt("POLYMARKET_NO_INDEX"),
  polymarketYesIndex: environmentBigInt("POLYMARKET_YES_INDEX"),
  priceTickRawX18: checkedUint("PRICE_TICK_RAW_X18", 128),
  quoteToken: environmentAddress("USDG_ADDRESS"),
  rulesHash: environmentHex32("RULES_HASH"),
  tradingCutoff: checkedUint("TRADING_CUTOFF", 64),
  tradingOpen: checkedUint("TRADING_OPEN", 64),
} as const;

validateMarketCaps({
  baseStep: config.baseStep,
  priceTickRawX18: config.priceTickRawX18,
  minNotional: config.minNotional,
  maxOrderQuantity: config.maxOrderQuantity,
  maxOrderNotional: config.maxOrderNotional,
  maxWalletOpenNotional: config.maxWalletOpenNotional,
  maxMarketOpenNotional: config.maxMarketOpenNotional,
});

const { chainId, publicClient } = await createPublicChainClient();
const manifest = (await Bun.file(
  requiredEnvironment("DEPLOYMENT_MANIFEST"),
).json()) as DeploymentManifest;
await verifyDeploymentManifest(publicClient, manifest);
if (manifest.deployments.MarketRegistry?.address.toLowerCase() !== registry.toLowerCase()) {
  throw new Error("MARKET_REGISTRY_ADDRESS differs from the verified manifest");
}
const artifact = await loadArtifact("MarketRegistry");
const marketId = (await publicClient.readContract({
  abi: artifact.abi,
  address: registry,
  args: [config],
  functionName: "computeMarketId",
} as never)) as Hex;
const calldata = encodeFunctionData({
  abi: artifact.abi,
  args: [config, metadataUri],
  functionName: "createMarket",
} as never);

await publicClient.simulateContract({
  abi: artifact.abi,
  account: adminCaller,
  address: registry,
  args: [config, metadataUri],
  functionName: "createMarket",
} as never);

if (Bun.env.SUBMIT_ADMIN_ACTION !== "true") {
  writeOutput({
    action: "createMarket",
    calldata,
    chainId,
    expectedMarketId: marketId,
    from: adminCaller,
    mode: "simulation-only",
    to: registry,
  });
} else {
  const { account, chain, walletClient } = await createChainClients("ADMIN_PRIVATE_KEY");
  if (getAddress(account.address) !== adminCaller) {
    throw new Error("ADMIN_PRIVATE_KEY does not match ADMIN_CALLER_ADDRESS");
  }
  const hash = await walletClient.writeContract({
    abi: artifact.abi,
    account,
    address: registry,
    args: [config, metadataUri],
    chain,
    functionName: "createMarket",
  } as never);
  writeOutput({
    action: "createMarket",
    chainId,
    expectedMarketId: marketId,
    transactionHash: hash,
  });
}
