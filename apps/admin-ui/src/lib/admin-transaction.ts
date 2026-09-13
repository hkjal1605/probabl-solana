import type { VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";

/** Only signatures may change after preflight, including with in-place wallet mutation. */
export async function signReviewedTransaction(
  transaction: VersionedTransaction,
  sign: (transaction: VersionedTransaction) => Promise<VersionedTransaction>,
) {
  const reviewed = Buffer.from(transaction.message.serialize());
  const signed = await sign(transaction);
  if (!reviewed.equals(Buffer.from(signed.message.serialize())))
    throw new Error(
      "Wallet changed the reviewed instruction bundle. No transaction was sent. " +
        "Keep the app-provided network fee settings, then review and sign again.",
    );
  return signed;
}
