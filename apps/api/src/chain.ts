import {
  atomicOrderRouterAbi,
  conditionalExchangeAbi,
  conditionalSettlementAbi,
  marketRegistryAbi,
  payoutVaultAbi,
  positionRouterAbi,
  protocolFeeVaultAbi,
} from "@conditional-stocks/contract-bindings";
import {
  assertMarketUnits,
  FundingKind,
  type MarketUnits,
  type Order,
  orderTypedData,
  PRICE_FORMAT,
  Side,
} from "@conditional-stocks/domain";
import {
  type FundingState,
  GatewayError,
  GatewayErrorCode,
  type MarketSnapshot,
  parseOrder,
  type ValidationSnapshot,
} from "@conditional-stocks/gateway";
import {
  ATOMIC_EXECUTION_VERSION,
  type AtomicPlan,
  type MatchCandidate,
  type StaleReservation,
} from "@conditional-stocks/orderbook";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddress,
  isHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";

import type { ApiEnvironment } from "./environment.ts";

const erc1155ReadAbi = [
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    name: "isApprovedForAll",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const erc1155ApprovalAbi = [
  {
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    name: "setApprovalForAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface CanonicalOrder {
  confirmation: "confirmed" | "finalized" | "observed";
  id: Hex;
  maker: Address;
  marketId: Hex;
  remaining: string;
  reserved: string;
  status: string;
  updatedBlock: string;
  [key: string]: unknown;
}

export interface CanonicalMarket extends MarketUnits {
  baseStep: string;
  baseToken: Address;
  conditionId: Hex;
  id: Hex;
  maxMarketOpenNotional: string;
  maxOrderNotional: string;
  maxOrderQuantity: string;
  maxWalletOpenNotional: string;
  metadataHash: Hex;
  minNotional: string;
  polymarketConditionId: Hex;
  polymarketNoIndex: string;
  polymarketYesIndex: string;
  priceTickRawX18: string;
  quoteToken: Address;
  rulesHash: Hex;
  state: number;
  stateReasonHash: Hex;
  tradingCutoff: string;
  tradingOpen: string;
  [key: string]: unknown;
}

export interface CanonicalResolution {
  admin: Address;
  evidenceHash: Hex;
  evidenceUri: string;
  noPayout: string;
  payoutDenominator: string;
  transactionHash: Hex;
  yesPayout: string;
}

export interface CanonicalTransaction {
  blockHash: Hex;
  blockNumber: string;
  confirmation: "confirmed" | "finalized" | "observed";
  hash: Hex;
  status: string;
}

interface IndexerHealth {
  healthy: boolean;
  head: {
    confirmedBlock: string;
    finalizedBlock: string;
    indexedBlock: string;
  };
}

export class IndexerClient {
  constructor(readonly baseUrl: string) {}

  async health(): Promise<IndexerHealth> {
    return this.#json<IndexerHealth>("/indexer/health");
  }

  async matchCandidates(
    order: Order,
    snapshot: ValidationSnapshot,
    makerFeeBps: number,
    exchange: Address,
    timestamp: bigint,
  ): Promise<MatchCandidate[]> {
    const query = new URLSearchParams({
      marketId: order.marketId,
      branch: String(order.branch),
      side: String(order.side === Side.Buy ? Side.Sell : Side.Buy),
      atBlock: String(snapshot.safeBlockNumber),
      makerFeeBps: String(makerFeeBps),
      limitPriceRawX18: String(order.limitPriceRawX18),
      timestamp: String(timestamp),
    });
    const body = await this.#json<{
      chainId: number;
      exchange: string;
      blockNumber: string;
      blockHash: Hex;
      candidates: { order: unknown; orderHash: Hex; remaining: string; sequence: string }[];
    }>(`/internal/match-candidates?${query}`);
    if (
      !body ||
      body.chainId !== Number(snapshot.chainId) ||
      typeof body.exchange !== "string" ||
      body.exchange.toLowerCase() !== exchange.toLowerCase() ||
      body.blockNumber !== String(snapshot.safeBlockNumber) ||
      body.blockHash !== snapshot.safeBlockHash ||
      !Array.isArray(body.candidates) ||
      body.candidates.length > 33
    )
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "Candidate book identity or anchor mismatch",
        503,
      );
    return body.candidates.map((candidate) => {
      if (
        !candidate ||
        typeof candidate.remaining !== "string" ||
        typeof candidate.sequence !== "string" ||
        typeof candidate.orderHash !== "string" ||
        !/^(0|[1-9][0-9]{0,38})$/.test(candidate.remaining) ||
        !/^(0|[1-9][0-9]{0,19})$/.test(candidate.sequence) ||
        !/^0x[0-9a-fA-F]{64}$/.test(candidate.orderHash)
      )
        throw new GatewayError(
          GatewayErrorCode.CanonicalStateUnavailable,
          "Malformed maker candidate",
          503,
        );
      return {
        order: parseOrder(candidate.order),
        orderHash: candidate.orderHash,
        remaining: BigInt(candidate.remaining),
        sequence: BigInt(candidate.sequence),
      };
    });
  }

  async order(orderHash: Hex): Promise<CanonicalOrder | null> {
    const response = await fetch(`${this.baseUrl}/orders/${orderHash}`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`indexer order request failed: ${response.status}`);
    return (await response.json()) as CanonicalOrder;
  }

  async staleReservations(
    order: Order,
    snapshot: ValidationSnapshot,
    exchange: Address,
    timestamp: bigint,
  ): Promise<StaleReservation[]> {
    const query = new URLSearchParams({
      marketId: order.marketId,
      maker: order.maker,
      atBlock: String(snapshot.safeBlockNumber),
      timestamp: String(timestamp),
    });
    const body = await this.#json<{
      chainId: number;
      exchange: string;
      blockNumber: string;
      blockHash: Hex;
      candidates: { orderHash: Hex; maker: Address; marketId: Hex; openNotional: string }[];
    }>(`/internal/stale-reservations?${query}`);
    if (
      !body ||
      body.chainId !== Number(snapshot.chainId) ||
      typeof body.exchange !== "string" ||
      body.exchange.toLowerCase() !== exchange.toLowerCase() ||
      body.blockNumber !== String(snapshot.safeBlockNumber) ||
      body.blockHash !== snapshot.safeBlockHash ||
      !Array.isArray(body.candidates) ||
      body.candidates.length > 33
    )
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "Recovery book identity or anchor mismatch",
        503,
      );
    return body.candidates.map((row) => {
      if (
        !row ||
        typeof row.orderHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(row.orderHash) ||
        typeof row.maker !== "string" ||
        !isAddress(row.maker) ||
        typeof row.marketId !== "string" ||
        row.marketId.toLowerCase() !== order.marketId.toLowerCase() ||
        typeof row.openNotional !== "string" ||
        !/^[1-9][0-9]{0,38}$/.test(row.openNotional) ||
        BigInt(row.openNotional) >= 1n << 128n
      )
        throw new GatewayError(
          GatewayErrorCode.CanonicalStateUnavailable,
          "Malformed stale reservation",
          503,
        );
      return {
        orderHash: row.orderHash.toLowerCase() as Hex,
        maker: getAddress(row.maker),
        marketId: row.marketId,
        openNotional: BigInt(row.openNotional),
      };
    });
  }

  async market(marketId: Hex): Promise<CanonicalMarket | null> {
    const response = await fetch(`${this.baseUrl}/markets/${marketId}`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`indexer market request failed: ${response.status}`);
    return (await response.json()) as CanonicalMarket;
  }

  async resolution(marketId: Hex): Promise<CanonicalResolution | null> {
    const response = await fetch(`${this.baseUrl}/resolutions/${marketId}`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`indexer resolution request failed: ${response.status}`);
    return (await response.json()) as CanonicalResolution;
  }

  async transaction(transactionHash: Hex): Promise<CanonicalTransaction | null> {
    const response = await fetch(`${this.baseUrl}/transactions/${transactionHash}`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`indexer transaction request failed: ${response.status}`);
    return (await response.json()) as CanonicalTransaction;
  }

  async #json<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
    } catch (error) {
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "indexer unavailable",
        503,
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!response.ok) {
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        `indexer returned ${response.status}`,
        503,
      );
    }
    return (await response.json()) as T;
  }
}

export class ViemGatewayChain {
  readonly #public;

  constructor(readonly environment: ApiEnvironment) {
    const transport = http(environment.rpcUrl, { batch: true });
    this.#public = createPublicClient({ transport });
  }

  async assertNetwork(): Promise<void> {
    const [router, executionVersion, routerExchange, payoutVault, payoutExchange, payoutCtf] =
      await Promise.all([
        this.#public.readContract({
          abi: conditionalExchangeAbi,
          address: this.environment.exchange,
          functionName: "atomicRouter",
        }),
        this.#public.readContract({
          abi: atomicOrderRouterAbi,
          address: this.environment.atomicRouter,
          functionName: "EXECUTION_VERSION",
        }),
        this.#public.readContract({
          abi: atomicOrderRouterAbi,
          address: this.environment.atomicRouter,
          functionName: "exchange",
        }),
        this.#public.readContract({
          abi: conditionalExchangeAbi,
          address: this.environment.exchange,
          functionName: "payoutVault",
        }),
        this.#public.readContract({
          abi: payoutVaultAbi,
          address: this.environment.payoutVault,
          functionName: "exchange",
        }),
        this.#public.readContract({
          abi: payoutVaultAbi,
          address: this.environment.payoutVault,
          functionName: "conditionalTokens",
        }),
      ]);
    if (
      router.toLowerCase() !== this.environment.atomicRouter.toLowerCase() ||
      executionVersion !== BigInt(ATOMIC_EXECUTION_VERSION) ||
      payoutVault.toLowerCase() !== this.environment.payoutVault.toLowerCase() ||
      payoutExchange.toLowerCase() !== this.environment.exchange.toLowerCase() ||
      payoutCtf.toLowerCase() !== this.environment.conditionalTokens.toLowerCase() ||
      routerExchange.toLowerCase() !== this.environment.exchange.toLowerCase()
    )
      throw new Error("API requires the configured permissionless atomic router");
    const version = await this.#public.readContract({
      abi: marketRegistryAbi,
      address: this.environment.marketRegistry,
      functionName: "PROTOCOL_VERSION",
    });
    if (version !== 2)
      throw new GatewayError(
        GatewayErrorCode.ChainMismatch,
        "API requires v2 raw-unit ratio contracts",
        503,
      );
    const chainId = await this.#public.getChainId();
    if (chainId !== this.environment.chainId) {
      throw new GatewayError(
        GatewayErrorCode.ChainMismatch,
        `RPC chain ${chainId} does not match ${this.environment.chainId}`,
        503,
      );
    }
  }

  async snapshot(order: Order, indexer: IndexerClient): Promise<ValidationSnapshot> {
    const health = await indexer.health();
    if (!health.healthy) {
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "indexer is not healthy",
        503,
      );
    }
    const safeBlockNumber = BigInt(health.head.confirmedBlock);
    const [
      block,
      marketRaw,
      minimumNonce,
      walletOpenNotional,
      marketOpenNotional,
      tradingPaused,
      nextSequence,
    ] = await Promise.all([
      this.#public.getBlock({ blockNumber: safeBlockNumber }),
      this.#public.readContract({
        abi: marketRegistryAbi,
        address: this.environment.marketRegistry,
        args: [order.marketId],
        blockNumber: safeBlockNumber,
        functionName: "getMarket",
      }),
      this.#public.readContract({
        abi: conditionalExchangeAbi,
        address: this.environment.exchange,
        args: [order.maker],
        blockNumber: safeBlockNumber,
        functionName: "minimumNonce",
      }),
      this.#public.readContract({
        abi: conditionalExchangeAbi,
        address: this.environment.exchange,
        args: [order.marketId, order.maker],
        blockNumber: safeBlockNumber,
        functionName: "walletOpenNotional",
      }),
      this.#public.readContract({
        abi: conditionalExchangeAbi,
        address: this.environment.exchange,
        args: [order.marketId],
        blockNumber: safeBlockNumber,
        functionName: "marketOpenNotional",
      }),
      this.#public.readContract({
        abi: conditionalExchangeAbi,
        address: this.environment.exchange,
        blockNumber: safeBlockNumber,
        functionName: "tradingPaused",
      }),
      this.#public.readContract({
        abi: conditionalExchangeAbi,
        address: this.environment.exchange,
        blockNumber: safeBlockNumber,
        functionName: "nextSequence",
        args: [order.marketId, order.branch],
      }),
    ]);
    const market = marketRaw as typeof marketRaw & Record<string, unknown>;
    const [baseTokenDecimals, quoteTokenDecimals, protocolVersion] = await Promise.all([
      this.#public.readContract({
        abi: erc20Abi,
        address: market.baseToken,
        functionName: "decimals",
        blockNumber: safeBlockNumber,
      }),
      this.#public.readContract({
        abi: erc20Abi,
        address: market.quoteToken,
        functionName: "decimals",
        blockNumber: safeBlockNumber,
      }),
      this.#public.readContract({
        abi: marketRegistryAbi,
        address: this.environment.marketRegistry,
        functionName: "PROTOCOL_VERSION",
        blockNumber: safeBlockNumber,
      }),
    ]);
    const units = {
      baseTokenDecimals,
      quoteTokenDecimals,
      protocolVersion,
      priceFormat: PRICE_FORMAT,
    };
    assertMarketUnits(units);
    const canonicalMarket = await indexer.market(order.marketId);
    assertMarketUnits(canonicalMarket);
    if (
      canonicalMarket.baseTokenDecimals !== baseTokenDecimals ||
      canonicalMarket.quoteTokenDecimals !== quoteTokenDecimals
    ) {
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "Token decimals changed since market creation; halt and review human price units",
        503,
      );
    }
    if (!block.hash)
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "Safe block has no canonical hash",
        503,
      );
    const marketSnapshot: MarketSnapshot = {
      ...units,
      baseStep: market.baseStep,
      baseToken: getAddress(market.baseToken),
      conditionId: market.conditionId,
      conditionalTokens: this.environment.conditionalTokens,
      maxMarketOpenNotional: market.maxMarketOpenNotional,
      maxOrderNotional: market.maxOrderNotional,
      maxOrderQuantity: market.maxOrderQuantity,
      maxWalletOpenNotional: market.maxWalletOpenNotional,
      minNotional: market.minNotional,
      priceTickRawX18: market.priceTickRawX18,
      quoteNoPositionId: market.quoteNoPositionId,
      quoteToken: getAddress(market.quoteToken),
      quoteYesPositionId: market.quoteYesPositionId,
      state: market.state,
      stockNoPositionId: market.stockNoPositionId,
      stockYesPositionId: market.stockYesPositionId,
      tradingCutoff: market.tradingCutoff,
      tradingOpen: market.tradingOpen,
    };
    return {
      chainId: BigInt(this.environment.chainId),
      market: marketSnapshot,
      marketOpenNotional,
      minimumNonce,
      nextSequence,
      safeBlockNumber,
      safeBlockHash: block.hash,
      safeBlockTimestamp: block.timestamp,
      tradingPaused,
      walletOpenNotional,
    };
  }

  async funding(
    order: Order,
    market: MarketSnapshot,
    safeBlockNumber: bigint,
  ): Promise<FundingState> {
    const amountToken = order.side === Side.Buy ? market.quoteToken : market.baseToken;
    if (order.fundingKind === FundingKind.WholeCollateral) {
      const [balance, allowance] = await Promise.all([
        this.#public.readContract({
          abi: erc20Abi,
          address: amountToken,
          args: [order.maker],
          blockNumber: safeBlockNumber,
          functionName: "balanceOf",
        }),
        this.#public.readContract({
          abi: erc20Abi,
          address: amountToken,
          args: [order.maker, this.environment.exchange],
          blockNumber: safeBlockNumber,
          functionName: "allowance",
        }),
      ]);
      return { allowance, approvedForAll: null, balance };
    }
    const tokenId =
      order.side === Side.Buy
        ? order.branch === 0
          ? market.quoteYesPositionId
          : market.quoteNoPositionId
        : order.branch === 0
          ? market.stockYesPositionId
          : market.stockNoPositionId;
    const [balance, approvedForAll] = await Promise.all([
      this.#public.readContract({
        abi: erc1155ReadAbi,
        address: this.environment.conditionalTokens,
        args: [order.maker, tokenId],
        blockNumber: safeBlockNumber,
        functionName: "balanceOf",
      }),
      this.#public.readContract({
        abi: erc1155ReadAbi,
        address: this.environment.conditionalTokens,
        args: [order.maker, this.environment.exchange],
        blockNumber: safeBlockNumber,
        functionName: "isApprovedForAll",
      }),
    ]);
    return { allowance: null, approvedForAll, balance };
  }

  async verifyOrderSignature(order: Order, signature: Hex, blockNumber?: bigint): Promise<boolean> {
    return this.#public.verifyTypedData({
      address: order.maker,
      blockNumber,
      ...orderTypedData(order, {
        chainId: BigInt(this.environment.chainId),
        verifyingContract: this.environment.exchange,
      }),
      message: { ...order },
      signature,
    });
  }

  async verifyAuthMessage(address: Address, message: string, signature: Hex): Promise<boolean> {
    return this.#public.verifyMessage({ address, message, signature });
  }

  async executionContext(order: Order) {
    const block = await this.#public.getBlock({ blockTag: "latest" });
    const settlement = await this.#public.readContract({
      abi: conditionalExchangeAbi,
      address: this.environment.exchange,
      functionName: "settlement",
      blockNumber: block.number,
    });
    const vault = await this.#public.readContract({
      abi: conditionalSettlementAbi,
      address: settlement,
      functionName: "feeVault",
      blockNumber: block.number,
    });
    const [[makerFeeBps, takerFeeBps], nextSequence] = await Promise.all([
      this.#public.readContract({
        abi: protocolFeeVaultAbi,
        address: vault,
        functionName: "feeRates",
        blockNumber: block.number,
      }),
      this.#public.readContract({
        abi: conditionalExchangeAbi,
        address: this.environment.exchange,
        functionName: "nextSequence",
        args: [order.marketId, order.branch],
        blockNumber: block.number,
      }),
    ]);
    return {
      timestamp: block.timestamp,
      blockNumber: block.number,
      makerFeeBps,
      takerFeeBps,
      nextSequence,
    };
  }

  atomicCalldata(order: Order, signature: Hex, plan: AtomicPlan): Hex {
    return encodeFunctionData({
      abi: atomicOrderRouterAbi,
      functionName: "placeAndMatchChecked",
      args: [
        order,
        signature,
        plan.makers,
        plan.quantities,
        plan.expectedRemaining,
        plan.deadline,
        plan.guard,
        plan.releaseOrders,
      ],
    });
  }

  async simulateAtomic(order: Order, signature: Hex, plan: AtomicPlan): Promise<void> {
    await this.#public.simulateContract({
      abi: atomicOrderRouterAbi,
      account: order.maker,
      address: this.environment.atomicRouter,
      functionName: "placeAndMatchChecked",
      args: [
        order,
        signature,
        plan.makers,
        plan.quantities,
        plan.expectedRemaining,
        plan.deadline,
        plan.guard,
        plan.releaseOrders,
      ],
    });
  }

  cancelOrderCalldata(orderHash: Hex): Hex {
    return encodeFunctionData({
      abi: conditionalExchangeAbi,
      args: [orderHash],
      functionName: "cancelOrder",
    });
  }

  recoveryCalldata(orderHash: Hex, kind: "expired" | "invalidated" | "closed"): Hex {
    return encodeFunctionData({
      abi: conditionalExchangeAbi,
      functionName: (
        {
          expired: "releaseExpiredOrder",
          invalidated: "releaseInvalidatedOrder",
          closed: "releaseClosedMarketOrder",
        } as const
      )[kind],
      args: [orderHash],
    });
  }

  async payoutCredit(beneficiary: Address, asset: Address, tokenId: bigint): Promise<bigint> {
    return this.#public.readContract({
      abi: payoutVaultAbi,
      address: this.environment.payoutVault,
      functionName: "claimable",
      args: [beneficiary, asset, tokenId],
    });
  }

  payoutWithdrawalCalldata(
    asset: Address,
    tokenId: bigint,
    amount: bigint,
    recipient: Address,
  ): Hex {
    return encodeFunctionData({
      abi: payoutVaultAbi,
      functionName: "withdraw",
      args: [asset, tokenId, amount, recipient],
    });
  }

  mergeCalldata(
    collateralToken: Address,
    conditionId: Hex,
    amount: bigint,
    recipient: Address,
  ): Hex {
    return encodeFunctionData({
      abi: positionRouterAbi,
      args: [collateralToken, conditionId, amount, recipient],
      functionName: "mergeForUser",
    });
  }

  redeemCalldata(
    collateralToken: Address,
    conditionId: Hex,
    indexSets: bigint[],
    amounts: bigint[],
    recipient: Address,
  ): Hex {
    return encodeFunctionData({
      abi: positionRouterAbi,
      args: [collateralToken, conditionId, indexSets, amounts, recipient],
      functionName: "redeemForUser",
    });
  }

  async positionRouterApproved(account: Address): Promise<boolean> {
    return this.#public.readContract({
      abi: erc1155ReadAbi,
      address: this.environment.conditionalTokens,
      args: [account, this.environment.positionRouter],
      functionName: "isApprovedForAll",
    });
  }

  positionApprovalCalldata(): Hex {
    return encodeFunctionData({
      abi: erc1155ApprovalAbi,
      args: [this.environment.positionRouter, true],
      functionName: "setApprovalForAll",
    });
  }

  async simulateUserCall(from: Address, to: Address, data: Hex): Promise<void> {
    await this.#public.call({ account: from, data, to, value: 0n });
  }

  async receipt(transactionHash: Hex): Promise<{
    blockHash: Hex;
    blockNumber: bigint;
    source: "rpc-observed";
    status: "reverted" | "success";
    transactionHash: Hex;
  } | null> {
    try {
      const receipt = await this.#public.getTransactionReceipt({ hash: transactionHash });
      return {
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        source: "rpc-observed",
        status: receipt.status,
        transactionHash,
      };
    } catch {
      return null;
    }
  }

  async broadcast(rawTransaction: Hex): Promise<Hex> {
    return this.#public.sendRawTransaction({ serializedTransaction: rawTransaction });
  }

  async validateRawTransaction(
    serializedTransaction: Hex,
    expected: { data: Hex; from: Address; to: Address },
  ): Promise<{ nonce: bigint; transactionHash: Hex }> {
    if (!isHex(serializedTransaction, { strict: true })) {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "invalid signed transaction");
    }
    const transaction = parseTransaction(serializedTransaction as TransactionSerialized);
    const from = await recoverTransactionAddress({
      serializedTransaction: serializedTransaction as TransactionSerialized,
    });
    if (
      getAddress(from) !== getAddress(expected.from) ||
      !transaction.to ||
      getAddress(transaction.to) !== getAddress(expected.to) ||
      transaction.data?.toLowerCase() !== expected.data.toLowerCase() ||
      (transaction.value ?? 0n) !== 0n ||
      transaction.chainId !== this.environment.chainId
    ) {
      throw new GatewayError(
        GatewayErrorCode.InvalidRequest,
        "signed transaction does not match the prepared action",
      );
    }
    if (transaction.nonce === undefined) {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "signed transaction has no nonce");
    }
    return {
      nonce: BigInt(transaction.nonce),
      transactionHash: keccak256(serializedTransaction),
    };
  }
}
