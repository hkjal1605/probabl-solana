import type { Address, Hex } from "viem";

export const PROTOCOL_VERSION = 2;
export const POLYGON_CHAIN_ID = 137n;

export const Branch = {
  Yes: 0,
  No: 1,
} as const;

export type Branch = (typeof Branch)[keyof typeof Branch];

export const Side = {
  Buy: 0,
  Sell: 1,
} as const;

export type Side = (typeof Side)[keyof typeof Side];

export const FundingKind = {
  WholeCollateral: 0,
  ActiveClaim: 1,
} as const;

export type FundingKind = (typeof FundingKind)[keyof typeof FundingKind];

export const TimeInForce = {
  Gtc: 0,
  Ioc: 1,
} as const;

export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

export interface MarketIdentity {
  baseToken: Address;
  polymarketConditionId: Hex;
  polymarketNoIndex: bigint;
  polymarketYesIndex: bigint;
  polygonChainId: bigint;
  protocolVersion: number;
  quoteToken: Address;
  robinhoodChainId: bigint;
  rulesHash: Hex;
  tradingCutoff: bigint;
  tradingOpen: bigint;
}

export interface Order {
  branch: Branch;
  expiry: bigint;
  fundingKind: FundingKind;
  limitPriceRawX18: bigint;
  maxFeeBps: number;
  maker: Address;
  marketId: Hex;
  nonce: bigint;
  quantity: bigint;
  recipient: Address;
  salt: Hex;
  side: Side;
  tif: TimeInForce;
}
