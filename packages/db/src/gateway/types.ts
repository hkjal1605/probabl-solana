import type { Address, Hex } from "viem";
export type OperationKind = "cancel" | "merge" | "order" | "redeem";
export type OperationState =
  | "accepted"
  | "broadcast"
  | "canonical"
  | "failed"
  | "prepared"
  | "retryable"
  | "submitted";

export interface OperationRecord {
  address: Address;
  canonicalState: unknown | null;
  createdAtMs: bigint;
  error: { code: string; message: string } | null;
  finalReceipt: unknown | null;
  idempotencyKey: string;
  kind: OperationKind;
  operationId: string;
  orderHash: Hex | null;
  payload: unknown;
  requestDigest: Hex;
  state: OperationState;
  transactionHash: Hex | null;
  updatedAtMs: bigint;
}

export interface TransactionAttempt {
  attempt: number;
  createdAtMs: bigint;
  nonce: bigint | null;
  operationId: string;
  rawTransaction: Hex | null;
  replaces: Hex | null;
  transactionHash: Hex;
}
