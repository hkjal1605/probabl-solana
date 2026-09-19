import { formatTokenAmount, parseTokenAmount } from "@conditional-stocks/domain";
import {
  type Envelope,
  envelope,
  key,
  SolanaClient,
  verifyEnvelope,
} from "@conditional-stocks/solana-client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { protocolConfig } from "@/config/protocol";
import type { WholeBalanceView } from "@/types/api";

export interface VaultQuote {
  transaction: Envelope;
  amount: string;
  minimumReceived: string;
  transferFee: string;
  scope: "global";
}
export function vaultAmount(text: string, decimals: number) {
  const amount = parseTokenAmount(text.trim(), decimals);
  if (amount <= 0n || amount >= 1n << 64n) throw new Error("Enter a positive token amount");
  return amount;
}
/** Verify the server's fee quote against the locally built transaction. The
 * wallet never signs an API-supplied destination or a lower credit floor. */
export function verifiedVaultTransaction(input: {
  action: "deposit" | "withdraw";
  owner: string;
  mint: string;
  amount: bigint;
  balance: WholeBalanceView;
  quote: VaultQuote;
  nativeLamports?: bigint;
  client?: SolanaClient;
}) {
  const { action, amount, balance, quote: remote } = input;
  if (!balance.tokenProgram) throw new Error("Token program is not indexed");
  const minimum = BigInt(remote.minimumReceived);
  if (
    remote.scope !== "global" ||
    remote.amount !== String(amount) ||
    minimum <= 0n ||
    minimum > amount ||
    BigInt(remote.transferFee) !== amount - minimum
  )
    throw new Error("Vault transfer quote differs from the selected amount");
  if (action === "withdraw" && BigInt(balance.vaultAvailable) < amount)
    throw new Error("Insufficient available vault balance");
  const client = input.client ?? new SolanaClient(protocolConfig),
    owner = key(input.owner),
    mint = key(input.mint),
    program = key(balance.tokenProgram);
  const instructions = [];
  if (action === "deposit" && mint.equals(NATIVE_MINT) && program.equals(TOKEN_PROGRAM_ID)) {
    const wrapped = BigInt(balance.canonicalBalance);
    const deficit = amount > wrapped ? amount - wrapped : 0n;
    if (deficit > 0n) {
      if (input.nativeLamports === undefined || input.nativeLamports < deficit + 20_000_000n)
        throw new Error("Not enough SOL to wrap this amount and pay network fees");
      const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: deficit }),
        createSyncNativeInstruction(ata),
      );
    }
  } else if (action === "deposit" && BigInt(balance.canonicalBalance) < amount) {
    throw new Error("Deposit exceeds the external wallet balance");
  }
  const vaultInstructions =
    action === "deposit"
      ? [client.depositPool(owner, mint, amount, program, minimum)]
      : client.withdrawPool(owner, mint, amount, owner, program, minimum);
  // The API prepares only the protocol transfer. Native SOL wrapping is a
  // locally constructed prefix, so it must not be compared to the API bundle.
  verifyEnvelope(envelope(vaultInstructions, client.program), remote);
  return {
    transaction: envelope([...instructions, ...vaultInstructions], client.program),
    received: formatTokenAmount(minimum, balance.decimals),
  };
}
