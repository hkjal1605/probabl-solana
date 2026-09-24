import {
  type ClaimActionKind,
  claimAction,
  type RecoveryPreview,
  redemptionPreview,
} from "@/protocol/engine";
import { type ProtocolTransaction, transaction } from "./transaction";

export type { ClaimActionKind, RecoveryPreview };

export interface ClaimActionInput {
  kind: ClaimActionKind;
  marketId: string;
  collateral: "Stock" | "Cash";
  branch: "All" | "YES" | "NO";
  amount: bigint;
}

/** Builds the exact redemption the wallet will sign, including what it burns. */
export function redemptionTransaction(
  input: ClaimActionInput,
  claims: { yes: bigint; no: bigint },
): { transaction: ProtocolTransaction; recovery: RecoveryPreview } {
  const yesAmount = input.branch === "NO" ? 0n : input.branch === "All" ? claims.yes : input.amount;
  const noAmount = input.branch === "YES" ? 0n : input.branch === "All" ? claims.no : input.amount;
  const recovery = redemptionPreview(yesAmount, noAmount);
  return {
    transaction: transaction(`redeem ${input.collateral} claims`, () => claimAction(input)),
    recovery,
  };
}

export function claimTransaction(input: ClaimActionInput): ProtocolTransaction {
  return transaction(`${input.kind.toLowerCase()} ${input.collateral} claims`, () =>
    claimAction(input),
  );
}
