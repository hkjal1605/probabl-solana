import type { MarketUnits } from "@conditional-stocks/domain";
import type { SpotPrice } from "@conditional-stocks/shared/spot-prices";
import type { TokenDisplayMetadata } from "../lib/tokens/devnet";

export type MarketLifecycle =
  | "scheduled"
  | "open"
  | "frozen"
  | "awaiting-resolution"
  | "resolved"
  | "redeemable"
  | "archived";
export type DataQuality =
  | "valid"
  | "low-depth"
  | "stale"
  | "one-sided"
  | "empty"
  | "crossed"
  | "disconnected";
export interface BookLevel {
  priceExact: string;
  price: number;
  quantity: number;
}
export interface BranchBook {
  bestAskExact: string | null;
  bestBidExact: string | null;
  bestAsk: number | null;
  bestBid: number | null;
  asks: BookLevel[];
  bids: BookLevel[];
  depthUsd: number;
  spread: number | null;
}
export interface ProbabilityView {
  ask: number | null;
  bid: number | null;
  observedAt: string | null;
  quality: DataQuality;
  value: number | null;
}
export interface MarketView extends MarketUnits {
  baseStep: string;
  priceTickRawX18?: string;
  bookQuality?: "available" | "unavailable" | "truncated";
  baseToken: string;
  baseTokenMetadata?: TokenDisplayMetadata;
  quoteTokenMetadata?: TokenDisplayMetadata;
  cutoff: string;
  createdAt?: string | null;
  description: string;
  eventImpact: number | null;
  id: string;
  lifecycle: MarketLifecycle;
  mapping: { conditionId: string; noIndex: string; polymarketUrl: string; yesIndex: string };
  no: BranchBook;
  ordinaryReference: number | null;
  spotReference?: SpotPrice;
  quoteSpotReference?: SpotPrice;
  probability: ProbabilityView;
  question: string;
  imageUrl?: string | null;
  quoteToken: string;
  residual: number | null;
  ticker: string;
  tradingOpen: string;
  yes: BranchBook;
}
export interface IndexedOrder {
  maxFeeBps?: number;
  feesPaid?: string;
  branch: number;
  confirmation?: string;
  expiry: string;
  fundingKind: number;
  id: string;
  limitPriceRawX18: string;
  maker: string;
  marketId: string;
  quantity: string;
  filled: string;
  remaining: string;
  reserved: string;
  side: number;
  status: string;
  tif: number;
  updatedBlock: string;
}
export interface WholeBalanceView {
  creditBalances?: Record<string, string>;
  decimals: number;
  account: string;
  blockNumber: string;
  canonicalBalance: string;
  token: string;
}
export interface PayoutCreditView {
  id: string;
  beneficiary: string;
  asset: string;
  tokenId: string;
  amount: string;
  collateralToken: string;
  decimals: number;
  branch: "YES" | "NO" | null;
  kind: "stock" | "quote";
  marketId: string | null;
  confirmation: string;
}
export interface PositionView extends MarketUnits {
  conditionId: string;
  marketId: string;
  quoteNo: string;
  quoteYes: string;
  redeemable: boolean;
  stockNo: string;
  stockYes: string;
}
export interface TradeView {
  branch: number;
  blockTimestamp: string;
  buyOrderHash?: string;
  confirmation?: string;
  executionPriceRawX18: string;
  executionQuote?: string;
  fillQuantity: string;
  id: string;
  makerOrderHash?: string;
  marketId: string;
  sellOrderHash?: string;
  takerOrderHash?: string;
  transactionHash: string;
}
export interface ResolutionView {
  admin: string | null;
  evidenceHash: string | null;
  evidenceUri: string | null;
  noPayout: string | null;
  payoutDenominator: string | null;
  transactionHash: string | null;
  yesPayout: string | null;
}
