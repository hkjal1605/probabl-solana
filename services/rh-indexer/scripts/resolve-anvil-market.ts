import {
  conditionalExchangeAbi,
  manualResolutionControllerAbi,
  marketRegistryAbi,
} from "@conditional-stocks/contract-bindings";
import type { ReconciliationSnapshot } from "@conditional-stocks/db/reconciliation/types";
import { hashResolutionCommitment } from "@conditional-stocks/domain";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isHex,
  keccak256,
  toBytes,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
const address = (name: string): Address => getAddress(required(name));
const rpcUrl = required("ROBINHOOD_RPC_URL").split(",")[0];
if (!rpcUrl) throw new Error("ROBINHOOD_RPC_URL must contain an HTTP URL");
const chainId = Number(required("ROBINHOOD_CHAIN_ID"));
if (chainId !== 31_337) {
  throw new Error(`resolution fixture only supports Anvil chain 31337, got ${chainId}`);
}
const marketId = required("MARKET_ID");
if (!isHex(marketId) || marketId.length !== 66) throw new Error("MARKET_ID must be bytes32");

const mnemonic =
  process.env.ANVIL_MNEMONIC ?? "test test test test test test test test test test test junk";
const accounts = Array.from({ length: 6 }, (_, addressIndex) =>
  mnemonicToAccount(mnemonic, { addressIndex }),
);
const marketAdmin = accounts[2];
const resolutionAdmin = marketAdmin;
if (!marketAdmin || !resolutionAdmin) throw new Error("could not derive Anvil admin accounts");
const accountByAddress = new Map(
  accounts.map((account) => [account.address.toLowerCase(), account]),
);

const publicClient = createPublicClient({ transport: http(rpcUrl) });
if ((await publicClient.getChainId()) !== chainId) throw new Error("connected to the wrong chain");
const exchange = address("EXCHANGE_ADDRESS");
const registry = address("MARKET_REGISTRY_ADDRESS");
const resolutionController = address("RESOLUTION_CONTROLLER_ADDRESS");
const transact = async (label: string, submit: () => Promise<`0x${string}`>): Promise<void> => {
  const hash = await submit();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
};

const indexerUrl = process.env.INDEXER_API_URL ?? "http://127.0.0.1:42069";
const response = await fetch(`${indexerUrl}/internal/reconciliation-snapshot?deep=true`);
if (!response.ok) throw new Error(`indexer snapshot failed with HTTP ${response.status}`);
const snapshot = (await response.json()) as ReconciliationSnapshot;
for (const order of snapshot.openOrders.filter(
  (candidate) => candidate.marketId.toLowerCase() === marketId.toLowerCase(),
)) {
  const maker = accountByAddress.get(order.maker.toLowerCase());
  if (!maker) throw new Error(`no local Anvil signer for order maker ${order.maker}`);
  const wallet = createWalletClient({ account: maker, transport: http(rpcUrl) });
  await transact(`cancel order ${order.id}`, () =>
    wallet.writeContract({
      abi: conditionalExchangeAbi,
      address: exchange,
      args: [order.id],
      functionName: "cancelOrder",
    } as never),
  );
}

const marketWallet = createWalletClient({ account: marketAdmin, transport: http(rpcUrl) });
const freezeReason = keccak256(toBytes("ANVIL_INDEXER_RESOLUTION_TEST"));
await transact("freeze market", () =>
  marketWallet.writeContract({
    abi: marketRegistryAbi,
    address: registry,
    args: [marketId, freezeReason],
    functionName: "freezeMarket",
  } as never),
);
const evidenceUri = "ipfs://conditional-stocks-anvil-resolution-evidence-v1";
const evidenceHash = keccak256(toBytes(evidenceUri));
const evidencePreparationHash = hashResolutionCommitment({
  chainId: BigInt(chainId),
  controller: resolutionController,
  marketId,
  yesPayout: 1n,
  noPayout: 0n,
  payoutDenominator: 1n,
  evidenceHash,
  evidenceUri,
});
await transact("begin resolution", () =>
  marketWallet.writeContract({
    abi: marketRegistryAbi,
    address: registry,
    args: [marketId, evidencePreparationHash],
    functionName: "beginResolution",
  } as never),
);

const resolutionWallet = createWalletClient({
  account: resolutionAdmin,
  transport: http(rpcUrl),
});
await transact("resolve market", () =>
  resolutionWallet.writeContract({
    abi: manualResolutionControllerAbi,
    address: resolutionController,
    args: [marketId, 1n, 0n, 1n, evidenceHash, evidenceUri],
    functionName: "resolveMarket",
  } as never),
);

process.stdout.write(
  `${JSON.stringify({ evidenceHash, evidenceUri, marketId, payout: [1, 0], state: "redeemable" }, null, 2)}\n`,
);
