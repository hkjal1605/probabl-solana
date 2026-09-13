import type {
  CreationEvidencePacket,
  EvidenceEnvelope,
  ResolutionEvidencePacket,
} from "@conditional-stocks/market-data";
import type { Address, Hex } from "viem";
export type EvidencePacket = CreationEvidencePacket | ResolutionEvidencePacket;
export type EvidenceStatus = "approved" | "prepared" | "rejected";
export type AdminAction = "begin-resolution" | "create-market" | "resolve-market";

export interface StoredEvidencePacket {
  envelope: EvidenceEnvelope<EvidencePacket>;
  packetId: string;
}

export interface EvidenceReview {
  checklist: Record<string, boolean>;
  decision: "approve" | "reject";
  notes: string;
  packetHash: Hex;
  reviewId: string;
  reviewedAt: string;
  reviewer: Address;
}

export interface AdminTransactionPreview {
  units?: import("@conditional-stocks/domain").MarketUnits;
  action: AdminAction;
  chainId: number;
  data: Hex;
  expectedMarketId: Hex;
  from: Address;
  packetHash: Hex;
  previewId: string;
  to: Address;
  value: "0";
}

export interface AdminTransactionObservation {
  action: AdminAction;
  canonical: unknown;
  observedAt: string;
  observationId: string;
  packetHash: Hex;
  transactionHash: Hex;
}

export interface AdminAuditRecord {
  action: string;
  actor: Address;
  createdAt: string;
  details: unknown;
  id: string;
  packetHash: Hex | null;
}
