import { formatTokenAmount, parseTokenAmount } from "@conditional-stocks/domain";
import { deposit, withdraw } from "@/protocol/engine";
import type { WholeBalanceView } from "@/types/api";
import { type ProtocolTransaction, transaction } from "./transaction";

export function vaultAmount(text: string, decimals: number) {
  const amount = parseTokenAmount(text.trim(), decimals);
  if (amount <= 0n || amount >= 1n << 64n) throw new Error("Enter a positive token amount");
  return amount;
}

/** Builds the transfer and the exact credit the vault will record for it. */
export function verifiedVaultTransaction(input: {
  action: "deposit" | "withdraw";
  owner: string;
  mint: string;
  amount: bigint;
  balance: WholeBalanceView;
}): { transaction: ProtocolTransaction; received: string } {
  const { action, amount, balance, mint } = input;
  if (action === "withdraw" && BigInt(balance.vaultAvailable) < amount)
    throw new Error("Insufficient available vault balance");
  if (action === "deposit" && BigInt(balance.canonicalBalance) < amount)
    throw new Error("Deposit exceeds the external wallet balance");
  return {
    transaction: transaction(`${action} ${amount} raw units of ${mint}`, () =>
      action === "deposit" ? deposit(mint, amount) : withdraw(mint, amount),
    ),
    received: formatTokenAmount(amount, balance.decimals),
  };
}
