import type { ShareUnits } from "@conditional-stocks/domain";
import type { SpotPrice } from "@conditional-stocks/shared/spot-prices";
import type { LegHalt } from "@conditional-stocks/solana-client";
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
/** Remaining share units at one price, by issuer-leg bitmask (bit i = collateral i + 1). */
export interface LevelBases {
  mask: number;
  quantity: number;
  quantityRaw: string;
}
export interface BookLevel {
  priceExact: string;
  price: number;
  /** Level total in shares (display only). */
  quantity: number;
  /** Asks: one single-bit mask per issuer. Bids: accepted-issuer masks. Absent when not indexed. */
  byBases?: LevelBases[];
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
/** Live issuer state of a leg, read by the indexer/API from the issuer mint and pool vault. */
export interface LegLiveView {
  /** Live ScaledUiAmount multiplier (f64 bits, decimal string). */
  multiplier: string;
  multiplierValue: number;
  paused: boolean;
  vaultFrozen: boolean;
  tradable: boolean;
  halt: LegHalt | null;
}
/** One listed issuer token ("base leg") of a multi-issuer market. */
export interface MarketLegView {
  /** 1..=3; asset 3c is the underlying, 3c + 1 YES, 3c + 2 NO. */
  collateral: number;
  /** 1 << (collateral - 1). */
  bit: number;
  mint: string;
  decimals: number;
  /** 10^(decimals - shareDecimals), decimal string. */
  scale: string;
  /** Listing multiplier (f64 bits, decimal string). */
  listingMultiplier: string;
  active: boolean;
  ready: boolean;
  claimMints: { yes: string; no: string };
  live?: LegLiveView;
  /** Display symbol, e.g. NVDAx (falls back to a synthetic label). */
  symbol: string;
  /** Display issuer name, e.g. xStocks, or null when unknown. */
  issuer: string | null;
  metadata?: TokenDisplayMetadata;
  spotReference?: SpotPrice;
}
export interface MarketView extends ShareUnits {
  baseStep: string;
  priceTickRawX18?: string;
  bookQuality?: "available" | "unavailable" | "truncated";
  /** Listed issuer legs in collateral order. */
  bases: MarketLegView[];
  /** All 12 asset mints (underlying 3c, YES 3c + 1, NO 3c + 2); unlisted entries are the default key. */
  claimMints: string[];
  quoteClaimMints: { yes: string; no: string };
  /** Stable identity of the traded asset (e.g. `asset:NVDA`) used to group sibling markets. */
  assetKey: string;
  /** Underlying asset display (e.g. NVDA), shared by every leg. */
  assetMetadata?: TokenDisplayMetadata;
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
  /** Share units. */
  quantity: string;
  filled: string;
  remaining: string;
  /** Raw units of the funding asset (quote for buys, the delivered leg for sells). */
  reserved: string;
  side: number;
  /** Issuer-leg bitmask: accepted legs for buys, exactly the delivered leg for sells. */
  bases: number;
  /** Delivered leg of a sell order (null for bids). */
  baseCollateral?: number | null;
  status: string;
  tif: number;
  updatedBlock: string;
}
export interface WholeBalanceView {
  vaultAvailable: string;
  reserved: string;
  tokenProgram?: string;
  externalBlockNumber?: string;
  creditBalances?: Record<string, string>;
  decimals: number;
  account: string;
  blockNumber: string;
  canonicalBalance: string;
  token: string;
}
export interface PayoutCreditView {
  scope: "global" | "market";
  pool: string | null;
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
/** Claims of one issuer leg, in raw units of that leg's own claim mints. */
export interface PositionLegView {
  collateral: number;
  mint: string;
  decimals: number;
  yes: string;
  no: string;
}
export interface PositionView {
  conditionId: string;
  marketId: string;
  shareDecimals: number;
  quoteTokenDecimals: number;
  protocolVersion: number;
  quoteNo: string;
  quoteYes: string;
  redeemable: boolean;
  bases: PositionLegView[];
}
export interface TradeView {
  branch: number;
  blockTimestamp: string;
  buyOrderHash?: string;
  confirmation?: string;
  executionPriceRawX18: string;
  executionQuote?: string;
  /** Share units. */
  fillQuantity: string;
  /** Delivered leg (collateral) and its raw amount. */
  base?: number;
  baseAmount?: string;
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
