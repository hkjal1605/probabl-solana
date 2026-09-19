import { Buffer } from "buffer";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import { coder } from "./protocol.ts";

export const PACKET_LIMIT = 1232;
export const COMPUTE_LIMIT = 1_400_000;

/** Conservative SBF-tested profiles, not API-supplied budgets. Unknown operations
 * keep the runtime's 200k default. No priority fee or extra simulation is needed. */
export function computeUnits(instructions: TransactionInstruction[], program: PublicKey): number {
  let units = 0;
  for (const ix of instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId))
      throw new Error("Unexpected compute budget instruction");
    const decoded = ix.programId.equals(program) ? coder.instruction.decode(ix.data) : null;
    if (decoded?.name === "place") {
      const legs = (decoded.data as { plan: { legs: unknown[] } }).plan.legs;
      if (!Array.isArray(legs) || legs.length > 8)
        throw new Error("Invalid placement compute plan");
      const participants = (decoded.data as { participants: number }).participants;
      const grants = (decoded.data as { delegations: number }).delegations;
      const credits = ix.keys.length - 20 - legs.length - 2 * participants - grants;
      if (
        !Number.isInteger(participants) ||
        participants < 1 ||
        participants > 2 * (legs.length + 1) || credits < 0 || credits > 10 ||
        !Number.isInteger(grants) || grants < 0 || grants > legs.length
      )
        throw new Error("Invalid placement participants");
      const writableMints = [12, 14, 16, 18].filter((i) => ix.keys[i]?.isWritable).length;
      units +=
        100_000 + 8_000 * credits + 7_000 * grants +
        (ix.keys[11]?.pubkey.equals(program) ? 0 : 15_000) +
        11_000 * legs.length +
        6_000 * participants +
        (legs.length ? 8_000 * writableMints : 0);
    } else if (decoded?.name === "cancel_orders" || decoded?.name === "retire_orders") {
      const count = (decoded.data as {order_count: number}).order_count;
      if (count < 1 || count > 8) throw new Error("Invalid maintenance batch");
      units += 50_000 + count * 15_000;
    } else if (decoded && ["split", "merge", "redeem"].includes(decoded.name)) units += 85_000;
    else if (decoded?.name === "cancel" || decoded?.name === "compact_market") units += 60_000;
    else units += 200_000;
  }
  // Never silently clamp a bundle that is larger than its measured allowance.
  if (units > COMPUTE_LIMIT)
    throw new Error("Transaction compute budget exceeds limit; reduce the batch");
  return units;
}

export function budgetedInstructions(instructions: TransactionInstruction[], program: PublicKey) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits(instructions, program) }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }),
    ...instructions,
  ];
}

/** No RPC. Exact v0 sizing including the signature vector and fee instructions.
 * Compilation can reject enormous messages before serialization; callers get
 * one actionable error rather than a wallet popup or a generic buffer failure. */
export function compileTransactionMessage(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  blockhash: string,
  tables: AddressLookupTableAccount[] = [],
) {
  try {
    const message = new TransactionMessage({
      payerKey: payer,
      instructions,
      recentBlockhash: blockhash,
    }).compileToV0Message(tables);
    if (message.staticAccountKeys.length + message.numAccountKeysFromLookups > 64)
      throw new Error("account limit");
    const signatures = message.header.numRequiredSignatures;
    const bytes = message.serialize().length + 1 + 64 * signatures;
    if (signatures >= 128 || bytes > PACKET_LIMIT) throw new Error("oversize");
    return message;
  } catch (error) {
    if (error instanceof Error && error.message === "account limit")
      throw new Error("Transaction exceeds the Solana account limit; reduce the batch");
    throw new Error(
      "Transaction exceeds the Solana packet limit; configure lookup tables or reduce the number of makers/instructions",
    );
  }
}

// A deterministic valid blockhash suffices for review-time sizing.
export const SIZING_BLOCKHASH = new PublicKey(Buffer.alloc(32)).toBase58();
