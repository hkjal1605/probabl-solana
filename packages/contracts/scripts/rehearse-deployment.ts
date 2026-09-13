/** Isolated local integration test. Only Anvil on loopback, using public development keys. */
import { resolve } from "node:path";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  keccak256,
  toBytes,
  zeroHash,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { conditionalTokensAbi } from "../../contract-bindings/src/index.ts";
import { hashOrder, orderTypedData } from "../../domain/src/order.ts";
import { hashResolutionCommitment } from "../../domain/src/resolution.ts";
import type { Order } from "../../domain/src/types.ts";
import { loadArtifact } from "./lib.ts";
import { roleIds } from "./security.ts";
import { type DeploymentManifest, verifyDeploymentManifest } from "./verify-deployment.ts";

const rpc = Bun.env.AUDIT_ANVIL_URL ?? "http://127.0.0.1:18546";
const url = new URL(rpc);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
  throw new Error("Rehearsal requires a loopback Anvil endpoint");
const client = createPublicClient({ transport: http(rpc) });
const testClient = createTestClient({ mode: "anvil", transport: http(rpc) });
if ((await client.getChainId()) !== 31337) throw new Error("Rehearsal requires chain 31337");
const version = await client.request({ method: "web3_clientVersion" });
if (!version.toLowerCase().includes("anvil")) throw new Error("Rehearsal requires Anvil");
const accounts = Array.from({ length: 6 }, (_, addressIndex) =>
  mnemonicToAccount("test test test test test test test test test test test junk", {
    addressIndex,
  }),
);
const account = (index: number) => {
  const value = accounts[index];
  if (!value) throw new Error("Missing test account");
  return value;
};
const wallet = (index: number) =>
  createWalletClient({ account: account(index), transport: http(rpc) });
const adminKey = (index: number): Hex => {
  const key = account(index).getHdKey().privateKey;
  if (!key) throw new Error("Missing public development key");
  return `0x${Buffer.from(key).toString("hex")}`;
};
const root = resolve(import.meta.dir, "..");
const output = Bun.env.AUDIT_DEPLOYMENT_OUTPUT;
if (!output) throw new Error("AUDIT_DEPLOYMENT_OUTPUT is required for isolated artifacts");
const env: Record<string, string> = {
  EXPECTED_CHAIN_ID: "31337",
  ROBINHOOD_RPC_URL: rpc,
  DEPLOYER_PRIVATE_KEY: adminKey(0),
  INITIAL_ADMIN: account(0).address,
  FINAL_ADMIN: account(1).address,
  MARKET_ADMIN: account(2).address,
  GUARDIAN: account(4).address,
  RESOLUTION_ADMIN: account(5).address,
  DEPLOYMENT_OUTPUT_DIRECTORY: output,
};
const run = async (
  script: string,
  additions: Record<string, string>,
  args: string[] = [],
  expectedFailure?: string,
) => {
  const proc = Bun.spawn(["bun", resolve(import.meta.dir, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env, ...additions },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (expectedFailure) {
    if (status === 0 || !stderr.includes(expectedFailure))
      throw new Error(`Expected ${expectedFailure}, received ${status}: ${stderr}`);
    return null;
  }
  if (status !== 0) throw new Error(`${script}: ${stderr}`);
  return JSON.parse(stdout);
};
const deployMock = async (name: string, args: readonly unknown[]): Promise<Address> => {
  const artifact = await loadArtifact(name, "MockTokens");
  const hash = await wallet(0).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args,
  } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error("Mock deployment failed");
  return receipt.contractAddress;
};
env.USDG_ADDRESS = await deployMock("MockERC20", ["Audit quote", "AQUOTE"]);
const stock = await deployMock("MockStockToken", []);
const nonce = await client.getTransactionCount({ address: account(0).address });
await run(
  "deploy-v1.ts",
  { DEPLOY_CONDITIONAL_TOKENS: "false", CONDITIONAL_TOKENS_ADDRESS: env.USDG_ADDRESS },
  [],
  "reviewed bytecode",
);
if ((await client.getTransactionCount({ address: account(0).address })) !== nonce)
  throw new Error("Incorrect dependency caused a broadcast");
const manifest = (await run("deploy-v1.ts", {
  DEPLOY_CONDITIONAL_TOKENS: "true",
})) as DeploymentManifest;
const address = (name: string) => {
  const record = manifest.deployments[name];
  if (!record) throw new Error(`Missing ${name}`);
  return record.address;
};
const manifestPath = resolve(output, `v2-${address("ProtocolAuthority").toLowerCase()}.json`);
try {
  await verifyDeploymentManifest(client, manifest);
  throw new Error("Incomplete handover was accepted");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("defaultAdmin mismatch")) throw error;
}
const authorityArtifact = await loadArtifact("ProtocolAuthority");
await testClient.increaseTime({ seconds: 172801 });
await testClient.mine({ blocks: 1 });
const acceptance = await wallet(1).writeContract({
  abi: authorityArtifact.abi,
  address: address("ProtocolAuthority"),
  functionName: "acceptDefaultAdminTransfer",
} as never);
await client.waitForTransactionReceipt({ hash: acceptance });
await verifyDeploymentManifest(client, manifest);
const unexpectedOperator = getAddress("0x000000000000000000000000000000000000bEEF");
const grant = await wallet(1).writeContract({
  abi: authorityArtifact.abi,
  address: address("ProtocolAuthority"),
  functionName: "grantRole",
  args: [roleIds.marketAdmin, unexpectedOperator],
} as never);
await client.waitForTransactionReceipt({ hash: grant });
try {
  await verifyDeploymentManifest(client, manifest);
  throw new Error("Unexpected operator outside manifest was accepted");
} catch (error) {
  if (
    !(error instanceof Error) ||
    !error.message.includes("Unexpected marketAdmin role membership")
  )
    throw error;
}
const revoke = await wallet(1).writeContract({
  abi: authorityArtifact.abi,
  address: address("ProtocolAuthority"),
  functionName: "revokeRole",
  args: [roleIds.marketAdmin, unexpectedOperator],
} as never);
await client.waitForTransactionReceipt({ hash: revoke });
await verifyDeploymentManifest(client, manifest);
const delayChange = await wallet(1).writeContract({
  abi: authorityArtifact.abi,
  address: address("ProtocolAuthority"),
  functionName: "changeDefaultAdminDelay",
  args: [0],
} as never);
await client.waitForTransactionReceipt({ hash: delayChange });
try {
  await verifyDeploymentManifest(client, manifest);
  throw new Error("Scheduled removal of admin delay was accepted");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("Scheduled default-admin delay"))
    throw error;
}
const delayRollback = await wallet(1).writeContract({
  abi: authorityArtifact.abi,
  address: address("ProtocolAuthority"),
  functionName: "rollbackDefaultAdminDelay",
} as never);
await client.waitForTransactionReceipt({ hash: delayRollback });
await verifyDeploymentManifest(client, manifest);
const exchange = address("ConditionalExchange");
const code = await client.getBytecode({ address: exchange });
if (!code) throw new Error("Exchange missing");
await testClient.setCode({ address: exchange, bytecode: "0x00" });
try {
  try {
    await verifyDeploymentManifest(client, manifest);
    throw new Error("Altered runtime was accepted");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("reviewed bytecode")) throw error;
  }
} finally {
  await testClient.setCode({ address: exchange, bytecode: code });
}
const registry = address("MarketRegistry");
const controller = address("ManualResolutionController");
const timestamp = (await client.getBlock()).timestamp;
const created = await run("create-market.ts", {
  DEPLOYMENT_MANIFEST: manifestPath,
  MARKET_REGISTRY_ADDRESS: registry,
  ADMIN_CALLER_ADDRESS: account(2).address,
  ADMIN_PRIVATE_KEY: adminKey(2),
  SUBMIT_ADMIN_ACTION: "true",
  METADATA_URI: "ipfs://audit-local-market",
  BASE_TOKEN_ADDRESS: stock,
  BASE_STEP: "1000000000000000000",
  PRICE_TICK_RAW_X18: "1000000000000000000",
  MIN_NOTIONAL: "1000000000000000000",
  MAX_ORDER_QUANTITY: "1000000000000000000",
  MAX_ORDER_NOTIONAL: "100000000000000000000",
  MAX_WALLET_OPEN_NOTIONAL: "100000000000000000000",
  MAX_MARKET_OPEN_NOTIONAL: "200000000000000000000",
  POLYMARKET_CONDITION_ID: keccak256(toBytes("AUDIT_CONDITION")),
  POLYMARKET_YES_INDEX: "1",
  POLYMARKET_NO_INDEX: "2",
  RULES_HASH: keccak256(toBytes("AUDIT_RULES")),
  TRADING_OPEN: timestamp.toString(),
  TRADING_CUTOFF: (timestamp + 86400n).toString(),
});
await client.waitForTransactionReceipt({ hash: created.transactionHash });
const marketId = created.expectedMarketId as Hex;
const registryArtifact = await loadArtifact("MarketRegistry");
// Actual signed fee-bearing settlement on the locally deployed, verified graph.
const exchangeArtifact = await loadArtifact("ConditionalExchange");
const vaultArtifact = await loadArtifact("ProtocolFeeVault");
const vault = address("ProtocolFeeVault");
const read = (
  target: Address,
  abi: typeof erc20Abi | typeof conditionalTokensAbi | typeof vaultArtifact.abi,
  functionName: string,
  args: readonly unknown[] = [],
) => client.readContract({ address: target, abi, functionName, args } as never);
const write = async (
  signer: number,
  target: Address,
  abi: typeof vaultArtifact.abi,
  functionName: string,
  args: readonly unknown[] = [],
) => {
  const hash = await wallet(signer).writeContract({
    address: target,
    abi,
    functionName,
    args,
  } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} failed in fee rehearsal`);
  return receipt;
};
const initialFees = (await read(vault, vaultArtifact.abi, "feeRates")) as readonly [number, number];
if (initialFees[0] !== 0 || initialFees[1] !== 0) throw new Error("Fees must start at zero");
await write(2, registry, registryArtifact.abi, "openMarket", [marketId]);
await write(1, vault, vaultArtifact.abi, "setFeeRates", [25, 75]);
const mockArtifact = await loadArtifact("MockERC20", "MockTokens");
await write(0, manifest.usdg, mockArtifact.abi, "mint", [account(0).address, 100n * 10n ** 18n]);
await write(0, stock, mockArtifact.abi, "mint", [account(4).address, 10n ** 18n]);
await write(0, manifest.usdg, erc20Abi, "approve", [exchange, 100n * 10n ** 18n]);
await write(4, stock, erc20Abi, "approve", [exchange, 10n ** 18n]);
const bid: Order = {
  maker: account(0).address,
  recipient: account(0).address,
  marketId,
  branch: 0,
  side: 0,
  fundingKind: 0,
  quantity: 10n ** 18n,
  limitPriceRawX18: 100n * 10n ** 18n,
  tif: 0,
  expiry: timestamp + 3600n,
  nonce: 0n,
  salt: zeroHash,
  maxFeeBps: 75,
};
const ask: Order = { ...bid, maker: account(4).address, recipient: account(4).address, side: 1 };
const domain = { chainId: 31337n, verifyingContract: exchange };
for (const [signer, order] of [
  [0, bid],
  [4, ask],
] as const) {
  const signature = await account(signer).signTypedData(orderTypedData(order, domain));
  const onchainHash = await read(exchange, exchangeArtifact.abi, "hashOrder", [order]);
  if (onchainHash !== hashOrder(order, domain)) throw new Error("Fee-capped EIP712 hash mismatch");
  const routerArtifact = await loadArtifact("AtomicOrderRouter");
  await write(signer, address("AtomicOrderRouter"), routerArtifact.abi, "placeAndMatch", [
    order,
    signature,
    signer === 4 ? [bid] : [],
    signer === 4 ? [bid.quantity] : [],
    signer === 4 ? [bid.quantity] : [],
    (await client.getBlock()).timestamp + 60n,
  ]);
}
const chainMarket = (await read(registry, registryArtifact.abi, "getMarket", [marketId])) as {
  stockYesPositionId: bigint;
  quoteYesPositionId: bigint;
  conditionId: Hex;
};
const expectedStockFee = 25n * 10n ** 14n;
const expectedCashFee = 75n * 10n ** 16n;
const claimBalance = (owner: Address, id: bigint) =>
  read(address("ConditionalTokens"), conditionalTokensAbi, "balanceOf", [
    owner,
    id,
  ]) as Promise<bigint>;
if (
  (await claimBalance(vault, chainMarket.stockYesPositionId)) !== expectedStockFee ||
  (await claimBalance(vault, chainMarket.quoteYesPositionId)) !== expectedCashFee ||
  (await claimBalance(bid.recipient, chainMarket.stockYesPositionId)) !==
    bid.quantity - expectedStockFee ||
  (await claimBalance(ask.recipient, chainMarket.quoteYesPositionId)) !==
    100n * 10n ** 18n - expectedCashFee
) {
  throw new Error("Fee-bearing settlement amounts differ from independent expected values");
}
await write(1, vault, vaultArtifact.abi, "claimFees", [
  account(1).address,
  [chainMarket.stockYesPositionId],
  [expectedStockFee],
]);
if ((await claimBalance(account(1).address, chainMarket.stockYesPositionId)) !== expectedStockFee)
  throw new Error("Admin claim failed");
await write(1, vault, vaultArtifact.abi, "setFeeRates", [0, 0]);
const frozen = await wallet(2).writeContract({
  abi: registryArtifact.abi,
  address: registry,
  functionName: "freezeMarket",
  args: [marketId, keccak256(toBytes("AUDIT_FREEZE"))],
} as never);
await client.waitForTransactionReceipt({ hash: frozen });
const resolutionEnv = {
  MARKET_ID: marketId,
  RESOLUTION_CONTROLLER_ADDRESS: controller,
  YES_PAYOUT: "1",
  NO_PAYOUT: "0",
  PAYOUT_DENOMINATOR: "1",
  EVIDENCE_HASH: keccak256(toBytes("AUDIT_EVIDENCE")),
  EVIDENCE_URI: "ipfs://audit-evidence",
  SUBMIT_ADMIN_ACTION: "true",
};
const prepared = await run(
  "resolve-market.ts",
  { ...resolutionEnv, ADMIN_CALLER_ADDRESS: account(2).address, ADMIN_PRIVATE_KEY: adminKey(2) },
  ["--prepare"],
);
await client.waitForTransactionReceipt({ hash: prepared.transactionHash });
const expectedCommitment = hashResolutionCommitment({
  chainId: 31337n,
  controller,
  marketId,
  yesPayout: 1n,
  noPayout: 0n,
  payoutDenominator: 1n,
  evidenceHash: resolutionEnv.EVIDENCE_HASH,
  evidenceUri: resolutionEnv.EVIDENCE_URI,
});
if (prepared.commitment !== expectedCommitment)
  throw new Error("Solidity/TypeScript commitment differs");
await run(
  "resolve-market.ts",
  {
    ...resolutionEnv,
    EVIDENCE_URI: "ipfs://substitution",
    ADMIN_CALLER_ADDRESS: account(5).address,
    ADMIN_PRIVATE_KEY: adminKey(5),
  },
  [],
  "revert",
);
const resolved = await run("resolve-market.ts", {
  ...resolutionEnv,
  ADMIN_CALLER_ADDRESS: account(5).address,
  ADMIN_PRIVATE_KEY: adminKey(5),
});
await client.waitForTransactionReceipt({ hash: resolved.transactionHash });
const state = await client.readContract({
  abi: registryArtifact.abi,
  address: registry,
  functionName: "marketState",
  args: [marketId],
});
if (Number(state) !== 6) throw new Error("Rehearsal market did not finalize");
await write(1, vault, vaultArtifact.abi, "redeemFees", [
  env.USDG_ADDRESS,
  chainMarket.conditionId,
  [1n],
  account(1).address,
]);
if ((await read(manifest.usdg, erc20Abi, "balanceOf", [account(1).address])) !== expectedCashFee)
  throw new Error("Vault resolution payout failed");
console.log(
  JSON.stringify(
    {
      passed: true,
      chainId: 31337,
      checks: [
        "wrong external CTF rejected before any broadcast",
        "all custom runtimes matched constructor execution",
        "all immutable wiring and operational roles verified",
        "maker/taker rates start at zero and admin can update and disable them",
        "v3 fee-capped Solidity/TypeScript signatures agree and real orders settle",
        "maker stock and taker USDG claim fees match independent calculations",
        "admin claims fees before resolution and redeems vault cash claims after resolution",
        "incomplete handover rejected",
        "completed delayed handover verified",
        "unexpected operator outside manifest rejected and revocation verified",
        "scheduled unsafe admin-delay reduction rejected and rollback verified",
        "altered deployed runtime rejected",
        "market creation CLI verified",
        "Solidity/TypeScript resolution commitment matched",
        "substituted resolution rejected",
        "exact resolution CLI finalized",
      ],
      manifestPath,
      authority: getAddress(address("ProtocolAuthority")),
      marketId,
      productionApproved: false,
    },
    null,
    2,
  ),
);
