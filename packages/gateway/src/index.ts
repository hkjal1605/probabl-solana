import {
  assertMarketUnits,
  Branch,
  FundingKind,
  hashOrder,
  type MarketUnits,
  ORDER_EIP712_NAME,
  ORDER_EIP712_VERSION,
  type Order,
  orderTypes,
  quoteForExecution,
  quoteForReservation,
  Side,
  TimeInForce,
} from "@conditional-stocks/domain";
import type { AtomicPlan } from "@conditional-stocks/orderbook";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  isAddress,
  isHex,
  zeroAddress,
} from "viem";

export const GATEWAY_SCHEMA_VERSION = 2 as const;
export const UINT64_MAX = 2n ** 64n - 1n;
export const UINT128_MAX = 2n ** 128n - 1n;

export const GatewayErrorCode = {
  ApprovalMissing: "approval-missing",
  BalanceInsufficient: "balance-insufficient",
  CanonicalStateUnavailable: "canonical-state-unavailable",
  ChainMismatch: "chain-mismatch",
  Conflict: "idempotency-conflict",
  FundingInvalid: "funding-invalid",
  InvalidRequest: "invalid-request",
  MarketCapExceeded: "market-cap-exceeded",
  MarketNotOpen: "market-not-open",
  NotAuthenticated: "not-authenticated",
  NotFound: "not-found",
  OrderExpired: "order-expired",
  OrderInvalid: "order-invalid",
  RpcUnavailable: "rpc-unavailable",
  SignatureInvalid: "signature-invalid",
  SimulationFailed: "simulation-failed",
  TransactionReverted: "transaction-reverted",
  WalletCapExceeded: "wallet-cap-exceeded",
} as const;

export type GatewayErrorCode = (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode];

export class GatewayError extends Error {
  override readonly name = "GatewayError";

  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface OrderWire {
  branch: number;
  expiry: string;
  fundingKind: number;
  limitPriceRawX18: string;
  maxFeeBps: number;
  maker: string;
  marketId: string;
  nonce: string;
  quantity: string;
  recipient: string;
  salt: string;
  side: number;
  tif: number;
}

export interface MarketSnapshot extends MarketUnits {
  baseStep: bigint;
  baseToken: Address;
  conditionId: Hex;
  conditionalTokens: Address;
  maxMarketOpenNotional: bigint;
  maxOrderNotional: bigint;
  maxOrderQuantity: bigint;
  maxWalletOpenNotional: bigint;
  minNotional: bigint;
  priceTickRawX18: bigint;
  quoteNoPositionId: bigint;
  quoteToken: Address;
  quoteYesPositionId: bigint;
  state: number;
  stockNoPositionId: bigint;
  stockYesPositionId: bigint;
  tradingCutoff: bigint;
  tradingOpen: bigint;
}

export interface ValidationSnapshot {
  chainId: bigint;
  market: MarketSnapshot;
  marketOpenNotional: bigint;
  minimumNonce: bigint;
  nextSequence: bigint;
  safeBlockNumber: bigint;
  safeBlockHash: Hex;
  safeBlockTimestamp: bigint;
  tradingPaused: boolean;
  walletOpenNotional: bigint;
}

export interface FundingState {
  allowance: bigint | null;
  approvedForAll: boolean | null;
  balance: bigint;
}

export interface AssetAmount {
  decimals: number;
  amount: bigint;
  assetAddress: Address;
  assetKind: "erc20" | "erc1155";
  tokenId: bigint | null;
}

export interface FundingRequirement extends AssetAmount {
  approvalCall: { data: Hex; to: Address } | null;
  approved: boolean;
  balanceSufficient: boolean;
  spender: Address;
}

export interface PayoffPreview {
  escrow: AssetAmount;
  outputsAtLimit: AssetAmount[];
  retainedComplement: AssetAmount | null;
}

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

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const integerString = (value: unknown, name: string, maximum: bigint): bigint => {
  if (typeof value === "string" && value.length > maximum.toString().length)
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} is outside its integer range`);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} must be a decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} is outside its integer range`);
  }
  return parsed;
};

const enumNumber = <T extends number>(value: unknown, allowed: readonly T[], name: string): T => {
  if (typeof value !== "number" || !Number.isInteger(value) || !allowed.includes(value as T)) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} is invalid`);
  }
  return value as T;
};

const address = (value: unknown, name: string): Address => {
  if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() === zeroAddress) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} must be a non-zero address`);
  }
  return getAddress(value);
};

const bytes32 = (value: unknown, name: string): Hex => {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} must be bytes32`);
  }
  return value.toLowerCase() as Hex;
};

export const parseOrder = (input: unknown): Order => {
  const value = record(input, "order");
  // Omitting a cap authorizes zero fees only; never silently authorize an admin maximum.
  const maxFeeBps = value.maxFeeBps ?? 0;
  if (
    typeof maxFeeBps !== "number" ||
    !Number.isInteger(maxFeeBps) ||
    maxFeeBps < 0 ||
    maxFeeBps > 1_000
  ) {
    throw new GatewayError(
      GatewayErrorCode.InvalidRequest,
      "order.maxFeeBps must be an integer from 0 to 1000",
    );
  }
  return {
    maxFeeBps,
    branch: enumNumber(value.branch, [Branch.Yes, Branch.No], "order.branch"),
    expiry: integerString(value.expiry, "order.expiry", UINT64_MAX),
    fundingKind: enumNumber(
      value.fundingKind,
      [FundingKind.WholeCollateral, FundingKind.ActiveClaim],
      "order.fundingKind",
    ),
    limitPriceRawX18: integerString(value.limitPriceRawX18, "order.limitPriceRawX18", UINT128_MAX),
    maker: address(value.maker, "order.maker"),
    marketId: bytes32(value.marketId, "order.marketId"),
    nonce: integerString(value.nonce, "order.nonce", UINT64_MAX),
    quantity: integerString(value.quantity, "order.quantity", UINT128_MAX),
    recipient: address(value.recipient, "order.recipient"),
    salt: bytes32(value.salt, "order.salt"),
    side: enumNumber(value.side, [Side.Buy, Side.Sell], "order.side"),
    tif: enumNumber(value.tif, [TimeInForce.Gtc, TimeInForce.Ioc], "order.tif"),
  };
};

export const orderToWire = (order: Order): OrderWire => ({
  ...order,
  expiry: order.expiry.toString(),
  limitPriceRawX18: order.limitPriceRawX18.toString(),
  nonce: order.nonce.toString(),
  quantity: order.quantity.toString(),
});

/** Decode only execution fields. Preview totals are always recomputed, never trusted. */
export function parseAtomicPlan(input: unknown, taker: Order): AtomicPlan {
  const value = record(input, "plan");
  const guard = record(value.guard, "plan.guard");
  const feeBps = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000)
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "Invalid quoted fee rate");
    return value;
  };
  const executionGuard = {
    nextSequence: integerString(guard.nextSequence, "guard.nextSequence", UINT64_MAX),
    makerFeeBps: feeBps(guard.makerFeeBps),
    takerFeeBps: feeBps(guard.takerFeeBps),
  };
  if (!Array.isArray(value.releaseOrders) || value.releaseOrders.length > 32)
    throw new GatewayError(GatewayErrorCode.InvalidRequest, "Invalid bounded stale recovery plan");
  const releaseOrders = value.releaseOrders.map((id, i) => bytes32(id, `releaseOrders[${i}]`));
  if (new Set(releaseOrders).size !== releaseOrders.length)
    throw new GatewayError(GatewayErrorCode.InvalidRequest, "Duplicate recovery order");
  if (
    !Array.isArray(value.makers) ||
    !Array.isArray(value.quantities) ||
    !Array.isArray(value.expectedRemaining) ||
    value.makers.length > 32 ||
    value.makers.length !== value.quantities.length ||
    value.makers.length !== value.expectedRemaining.length
  )
    throw new GatewayError(GatewayErrorCode.InvalidRequest, "Invalid bounded execution plan");
  const makers = value.makers.map(parseOrder);
  if (
    new Set(makers.map((maker) => JSON.stringify(orderToWire(maker)).toLowerCase())).size !==
    makers.length
  )
    throw new GatewayError(GatewayErrorCode.InvalidRequest, "Duplicate maker in execution plan");
  const quantities = value.quantities.map((item, i) =>
    integerString(item, `quantities[${i}]`, UINT128_MAX),
  );
  const expectedRemaining = value.expectedRemaining.map((item, i) =>
    integerString(item, `expectedRemaining[${i}]`, UINT128_MAX),
  );
  const deadline = integerString(value.deadline, "deadline", UINT64_MAX);
  const filledQuantity = quantities.reduce((sum, quantity) => sum + quantity, 0n);
  if (
    filledQuantity > taker.quantity ||
    deadline > taker.expiry ||
    deadline === 0n ||
    (makers.length > 0 && taker.maxFeeBps < executionGuard.takerFeeBps) ||
    makers.some(
      (maker, i) =>
        maker.tif !== TimeInForce.Gtc ||
        maker.marketId.toLowerCase() !== taker.marketId.toLowerCase() ||
        maker.branch !== taker.branch ||
        maker.side === taker.side ||
        deadline > maker.expiry ||
        maker.maxFeeBps < executionGuard.makerFeeBps ||
        maker.limitPriceRawX18 === 0n ||
        quantities[i] === 0n ||
        (quantities[i] ?? 0n) > (expectedRemaining[i] ?? 0n) ||
        (expectedRemaining[i] ?? 0n) > maker.quantity ||
        (taker.side === Side.Buy
          ? maker.limitPriceRawX18 > taker.limitPriceRawX18
          : maker.limitPriceRawX18 < taker.limitPriceRawX18),
    )
  )
    throw new GatewayError(
      GatewayErrorCode.InvalidRequest,
      "Execution plan violates signed order limits",
    );
  const executionQuote = makers.reduce((sum, maker, i) => {
    const quote = quoteForExecution(quantities[i] ?? 0n, maker.limitPriceRawX18);
    if (quote === 0n)
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "Fill rounds to zero quote");
    return sum + quote;
  }, 0n);
  return {
    guard: executionGuard,
    releaseOrders,
    makers,
    quantities,
    expectedRemaining,
    deadline,
    filledQuantity,
    remainingQuantity: taker.quantity - filledQuantity,
    executionQuote,
  };
}

export const orderTypedData = (order: Order, chainId: bigint, exchange: Address) => ({
  domain: {
    chainId,
    name: ORDER_EIP712_NAME,
    verifyingContract: exchange,
    version: ORDER_EIP712_VERSION,
  },
  message: order,
  primaryType: "Order" as const,
  types: orderTypes,
});

export const validateOrder = (
  order: Order,
  snapshot: ValidationSnapshot,
  requiredTif?: TimeInForce,
): bigint => {
  const { market } = snapshot;
  try {
    assertMarketUnits(market);
  } catch {
    throw new GatewayError(
      GatewayErrorCode.CanonicalStateUnavailable,
      "Verified v2 raw-unit market metadata is required",
      503,
    );
  }
  if (snapshot.tradingPaused) {
    throw new GatewayError(GatewayErrorCode.MarketNotOpen, "trading is paused");
  }
  if (
    market.state !== 2 ||
    snapshot.safeBlockTimestamp < market.tradingOpen ||
    snapshot.safeBlockTimestamp >= market.tradingCutoff
  ) {
    throw new GatewayError(GatewayErrorCode.MarketNotOpen, "market is not open at the safe block");
  }
  if (requiredTif !== undefined && order.tif !== requiredTif) {
    throw new GatewayError(GatewayErrorCode.OrderInvalid, "unexpected time-in-force");
  }
  if (order.quantity === 0n || order.limitPriceRawX18 === 0n) {
    throw new GatewayError(GatewayErrorCode.OrderInvalid, "quantity and price must be positive");
  }
  if (order.expiry <= snapshot.safeBlockTimestamp || order.expiry > market.tradingCutoff) {
    throw new GatewayError(GatewayErrorCode.OrderExpired, "expiry is outside the market window");
  }
  if (order.nonce < snapshot.minimumNonce) {
    throw new GatewayError(GatewayErrorCode.OrderInvalid, "nonce is below the maker minimum");
  }
  if (
    order.quantity % market.baseStep !== 0n ||
    order.limitPriceRawX18 % market.priceTickRawX18 !== 0n ||
    order.quantity > market.maxOrderQuantity
  ) {
    throw new GatewayError(
      GatewayErrorCode.OrderInvalid,
      "quantity or price violates market terms",
    );
  }
  const notional = quoteForReservation(order.quantity, order.limitPriceRawX18);
  if (notional < market.minNotional || notional > market.maxOrderNotional) {
    throw new GatewayError(GatewayErrorCode.OrderInvalid, "order notional violates market limits");
  }
  // Aggregate caps are validated against the final reviewed atomic resting state, after
  // maker reductions, stale recovery and IOC cancellation. Full funding remains required.
  return notional;
};

const activePositionId = (order: Order, market: MarketSnapshot): bigint => {
  if (order.side === Side.Buy) {
    return order.branch === Branch.Yes ? market.quoteYesPositionId : market.quoteNoPositionId;
  }
  return order.branch === Branch.Yes ? market.stockYesPositionId : market.stockNoPositionId;
};

const complementPositionId = (order: Order, market: MarketSnapshot): bigint => {
  if (order.side === Side.Buy) {
    return order.branch === Branch.Yes ? market.quoteNoPositionId : market.quoteYesPositionId;
  }
  return order.branch === Branch.Yes ? market.stockNoPositionId : market.stockYesPositionId;
};

export const fundingRequirement = (
  order: Order,
  market: MarketSnapshot,
  exchange: Address,
  funding: FundingState,
): FundingRequirement => {
  const amount =
    order.side === Side.Buy
      ? quoteForReservation(order.quantity, order.limitPriceRawX18)
      : order.quantity;
  if (order.fundingKind === FundingKind.WholeCollateral) {
    const assetAddress = order.side === Side.Buy ? market.quoteToken : market.baseToken;
    const approved = (funding.allowance ?? 0n) >= amount;
    return {
      decimals: order.side === Side.Buy ? market.quoteTokenDecimals : market.baseTokenDecimals,
      amount,
      approvalCall: approved
        ? null
        : {
            data: encodeFunctionData({
              abi: erc20Abi,
              args: [exchange, amount],
              functionName: "approve",
            }),
            to: assetAddress,
          },
      approved,
      assetAddress,
      assetKind: "erc20",
      balanceSufficient: funding.balance >= amount,
      spender: exchange,
      tokenId: null,
    } as FundingRequirement;
  }
  const approved = funding.approvedForAll === true;
  return {
    decimals: order.side === Side.Buy ? market.quoteTokenDecimals : market.baseTokenDecimals,
    amount,
    approvalCall: approved
      ? null
      : {
          data: encodeFunctionData({
            abi: erc1155ApprovalAbi,
            args: [exchange, true],
            functionName: "setApprovalForAll",
          }),
          to: market.conditionalTokens,
        },
    approved,
    assetAddress: market.conditionalTokens,
    assetKind: "erc1155",
    balanceSufficient: funding.balance >= amount,
    spender: exchange,
    tokenId: activePositionId(order, market),
  };
};

export const payoffPreview = (order: Order, market: MarketSnapshot): PayoffPreview => {
  const notional = quoteForReservation(order.quantity, order.limitPriceRawX18);
  const executionQuote = quoteForExecution(order.quantity, order.limitPriceRawX18);
  const escrow =
    order.fundingKind === FundingKind.WholeCollateral
      ? {
          amount: order.side === Side.Buy ? notional : order.quantity,
          decimals: order.side === Side.Buy ? market.quoteTokenDecimals : market.baseTokenDecimals,
          assetAddress: order.side === Side.Buy ? market.quoteToken : market.baseToken,
          assetKind: "erc20" as const,
          tokenId: null,
        }
      : {
          amount: order.side === Side.Buy ? notional : order.quantity,
          decimals: order.side === Side.Buy ? market.quoteTokenDecimals : market.baseTokenDecimals,
          assetAddress: market.conditionalTokens,
          assetKind: "erc1155" as const,
          tokenId: activePositionId(order, market),
        };
  const activeOutput: AssetAmount =
    order.side === Side.Buy
      ? {
          amount: order.quantity,
          decimals: market.baseTokenDecimals,
          assetAddress: market.conditionalTokens,
          assetKind: "erc1155",
          tokenId:
            order.branch === Branch.Yes ? market.stockYesPositionId : market.stockNoPositionId,
        }
      : {
          amount: executionQuote,
          decimals: market.quoteTokenDecimals,
          assetAddress: market.conditionalTokens,
          assetKind: "erc1155",
          tokenId:
            order.branch === Branch.Yes ? market.quoteYesPositionId : market.quoteNoPositionId,
        };
  const complement: AssetAmount = {
    decimals: order.side === Side.Buy ? market.quoteTokenDecimals : market.baseTokenDecimals,
    amount: order.side === Side.Buy ? executionQuote : order.quantity,
    assetAddress: market.conditionalTokens,
    assetKind: "erc1155",
    tokenId: complementPositionId(order, market),
  };
  return {
    escrow,
    outputsAtLimit:
      order.fundingKind === FundingKind.WholeCollateral
        ? [activeOutput, complement]
        : [activeOutput],
    retainedComplement:
      order.fundingKind === FundingKind.ActiveClaim
        ? { ...complement, amount: order.side === Side.Buy ? notional : order.quantity }
        : null,
  };
};

export const preparedOrder = (
  order: Order,
  snapshot: ValidationSnapshot,
  exchange: Address,
  funding: FundingState,
) => {
  const notional = validateOrder(order, snapshot);
  const requirement = fundingRequirement(order, snapshot.market, exchange, funding);
  return {
    chainContext: {
      chainId: snapshot.chainId,
      safeBlockNumber: snapshot.safeBlockNumber,
      safeBlockTimestamp: snapshot.safeBlockTimestamp,
    },
    funding: requirement,
    fees: {
      maxFeeBps: order.maxFeeBps,
      chargedOn: "received-active-claims" as const,
      asset: order.side === Side.Buy ? ("stock-claims" as const) : ("quote-claims" as const),
      payoffAmounts: "before-trading-fees" as const,
    },
    units: {
      baseTokenDecimals: snapshot.market.baseTokenDecimals,
      quoteTokenDecimals: snapshot.market.quoteTokenDecimals,
      protocolVersion: snapshot.market.protocolVersion,
      priceFormat: snapshot.market.priceFormat,
    },
    notional,
    orderHash: hashOrder(order, { chainId: snapshot.chainId, verifyingContract: exchange }),
    payoff: payoffPreview(order, snapshot.market),
    schemaVersion: GATEWAY_SCHEMA_VERSION,
    typedData: orderTypedData(order, snapshot.chainId, exchange),
  };
};
