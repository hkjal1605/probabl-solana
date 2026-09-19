export interface SnapshotWrite {
  slot: number;
  observedAt: number;
  accounts: Record<string, unknown>;
  pools: {
    address: string;
    mint: string;
    token_program: string;
    decimals: number;
    liability: string;
  }[];
  credits: { address: string; pool: string; owner: string; available: string }[];
  claims: { market: string; owner: string; mint: string; asset: number; available: string }[];
}
export interface HistoryCursor {
  signature: string;
  slot: string;
  snapshot_slot: string;
}
export interface StoredEvent {
  signature: string;
  event_index: number;
  slot: number;
  block_time: number;
  name: string;
  market: string | null;
  data: Record<string, unknown>;
}
