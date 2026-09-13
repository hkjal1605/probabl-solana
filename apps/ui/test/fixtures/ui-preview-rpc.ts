import { conditionalExchangeAbi, marketRegistryAbi } from "@conditional-stocks/contract-bindings";
import {
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
  zeroHash,
} from "viem";
import type { MarketView, PositionView } from "../../src/lib/api/types";

const ctf = "0x5000000000000000000000000000000000000005";
const registry = "0x4000000000000000000000000000000000000004";
export function previewRpc(
  body: { method: string; params?: unknown[] },
  markets: MarketView[],
  positions: PositionView[],
  approved: Set<string>,
): unknown {
  if (body.method === "eth_chainId") return "0x7a69";
  if (body.method === "eth_blockNumber") return "0x64";
  if (body.method === "eth_getTransactionReceipt")
    return {
      transactionHash: body.params?.[0],
      transactionIndex: "0x0",
      blockHash: `0x${"cd".repeat(32)}`,
      blockNumber: "0x64",
      from: "0xde00000000000000000000000000000000000001",
      to: ctf,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: "0x2",
    };
  if (body.method !== "eth_call") throw new Error("RPC method not mocked.");
  const call = body.params?.[0] as { to: string; data: Hex };
  try {
    const decoded = decodeFunctionData({ abi: conditionalExchangeAbi, data: call.data });
    if (decoded.functionName === "registry")
      return encodeFunctionResult({
        abi: conditionalExchangeAbi,
        functionName: "registry",
        result: registry,
      });
  } catch {
    /* Try the next fixture ABI. */
  }
  try {
    const decoded = decodeFunctionData({ abi: marketRegistryAbi, data: call.data });
    if (decoded.functionName === "ctf")
      return encodeFunctionResult({ abi: marketRegistryAbi, functionName: "ctf", result: ctf });
    if (decoded.functionName === "getMarket") {
      const market = markets.find((m) => m.id === decoded.args[0]),
        position = positions.find((p) => p.marketId === decoded.args[0]);
      if (!market || !position) throw new Error("Unknown market.");
      return encodeFunctionResult({
        abi: marketRegistryAbi,
        functionName: "getMarket",
        result: {
          baseToken: market.baseToken as Address,
          quoteToken: market.quoteToken as Address,
          localQuestionId: zeroHash,
          conditionId: position.conditionId as Hex,
          polymarketConditionId: market.mapping.conditionId as Hex,
          rulesHash: zeroHash,
          metadataHash: zeroHash,
          polymarketYesIndex: 1n,
          polymarketNoIndex: 2n,
          stockYesPositionId: 1n,
          stockNoPositionId: 2n,
          quoteYesPositionId: 3n,
          quoteNoPositionId: 4n,
          tradingOpen: 1n,
          tradingCutoff: BigInt(Math.floor(Date.parse(market.cutoff) / 1000)),
          priceTickRawX18: 1000n,
          baseStep: BigInt(market.baseStep),
          minNotional: 1n,
          maxOrderQuantity: 1n << 120n,
          maxOrderNotional: 1n << 120n,
          maxWalletOpenNotional: 1n << 120n,
          maxMarketOpenNotional: 1n << 120n,
          state: position.redeemable ? 6 : 2,
        },
      });
    }
  } catch {
    /* Try the token ABI. */
  }
  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
  if (decoded.functionName === "decimals")
    return encodeFunctionResult({
      abi: erc20Abi,
      functionName: "decimals",
      result: markets.some((m) => m.quoteToken.toLowerCase() === call.to.toLowerCase()) ? 6 : 18,
    });
  if (decoded.functionName === "balanceOf")
    return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 10n ** 25n });
  if (decoded.functionName === "allowance")
    return encodeFunctionResult({
      abi: erc20Abi,
      functionName: "allowance",
      result: approved.has(call.to.toLowerCase()) ? 10n ** 25n : 0n,
    });
  throw new Error("Contract method not mocked.");
}
