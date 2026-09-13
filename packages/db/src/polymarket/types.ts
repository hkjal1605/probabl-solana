import type { NormalizedPolymarketMarket } from "@conditional-stocks/market-data";
import type { Hex } from "viem";
export interface MetadataSnapshot {
  fetchedAtMs: string;
  normalized: NormalizedPolymarketMarket;
  rawHash: Hex;
  rawPayload: unknown;
  snapshotId: string;
}

export interface SubscriptionRecord {
  conditionId: Hex;
  gammaMarketId: string;
  metadataSnapshotId: string;
  yesTokenId: string;
}

export interface IngestorAlert {
  code: string;
  conditionId: Hex | null;
  createdAtMs: string;
  details: unknown;
  id: string;
}
