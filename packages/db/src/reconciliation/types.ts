import type { MarketUnits } from "@conditional-stocks/domain";
import type { Address, Hex } from "viem";

export interface SnapshotState {
  confirmedBlock: string;
  finalizedBlock: string;
  indexedBlock: string;
  indexedBlockHash: Hex;
  indexedBlockTimestamp: string;
}

export interface SnapshotMarket extends MarketUnits {
  baseToken: Address;
  conditionId: Hex;
  id: Hex;
  quoteNoPositionId: string | null;
  quoteToken: Address;
  quoteYesPositionId: string | null;
  state: number;
  stockNoPositionId: string | null;
  stockYesPositionId: string | null;
}

export interface SnapshotOrder {
  branch: number;
  fundingKind: number;
  id: Hex;
  limitPriceRawX18: string;
  maker: Address;
  marketId: Hex;
  nonce: string;
  openNotional: string;
  remaining: string;
  reserved: string;
  sequence: string;
  side: number;
  status: string;
}

export interface SnapshotResolution {
  evidenceHash: Hex;
  marketId: Hex;
  noPayout: string;
  payoutDenominator: string;
  yesPayout: string;
}

export interface SnapshotReservation {
  amount: string;
  assetAddress: Address;
  orderHash: Hex;
  tokenId: string | null;
}

export interface ReconciliationSnapshot {
  payoutCredits: Array<{ beneficiary: Address; asset: Address; tokenId: string; amount: string }>;
  payoutTotals: Array<{ asset: Address; tokenId: string; amount: string }>;
  claimTotals: Array<{ amount: string | null; positionId: string }>;
  deep: boolean;
  marketOpenInterest: Array<{ amount: string; marketId: Hex }>;
  markets: SnapshotMarket[];
  openOrders: SnapshotOrder[];
  reservationTotals: Array<{
    amount: string | null;
    assetAddress: Address;
    tokenId: string | null;
  }>;
  reservations: SnapshotReservation[];
  resolutions: SnapshotResolution[];
  state: SnapshotState;
  walletOpenInterest: Array<{ account: Address; amount: string; marketId: Hex }>;
}

export type ReconciliationSeverity = "critical" | "warning";

export interface ReconciliationIssue {
  actual: string;
  code: string;
  details: string;
  expected: string;
  freezeScope: string | null;
  severity: ReconciliationSeverity;
}

export interface ReconciliationReport {
  chainId: number;
  completedAt: string;
  deep: boolean;
  freezeRequired: boolean;
  freezeScopes: string[];
  indexedBlock: string;
  indexedBlockHash: Hex;
  issues: ReconciliationIssue[];
  projectionHash: Hex;
  projectionVersion: 3;
  startedAt: string;
  status: "ok" | "mismatch";
}
