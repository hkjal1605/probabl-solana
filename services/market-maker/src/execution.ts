import { Keypair, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { SolanaClient, envelope } from "@conditional-stocks/solana-client";
import type { Settings } from "./config.ts";
import type { State } from "./state.ts";

export function signer(secret: string, expected: string) {
  try {
    const raw: unknown = secret.trim().startsWith("[")
      ? JSON.parse(secret)
      : Array.from(bs58.decode(secret.trim()));
    if (
      !Array.isArray(raw) ||
      raw.length !== 64 ||
      raw.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    )
      throw new Error();
    const wallet = Keypair.fromSecretKey(Uint8Array.from(raw));
    if (wallet.publicKey.toBase58() !== expected) throw new Error();
    return wallet;
  } catch {
    throw new Error(
      "MM_PRIVATE_KEY must be a 64-byte keypair matching MM_WALLET_ADDRESS (value withheld)",
    );
  }
}
export class Executor {
  constructor(
    readonly client: SolanaClient,
    readonly wallet: Keypair,
    readonly settings: Settings,
    readonly state: State,
    readonly save: () => void,
  ) {}
  async reconcilePending() {
    const pending = this.state.pending;
    if (!pending) return;
    const result = await this.client.connection.getSignatureStatuses([pending.signature], {
      searchTransactionHistory: true,
    });
    const status = result.value[0];
    if (
      status &&
      (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
    ) {
      this.state.lastSlot = Math.max(this.state.lastSlot, status.slot);
      delete this.state.pending;
      this.save();
      if (status.err)
        throw new Error("Journaled transaction failed on chain; state will be reread");
      return;
    }
    if (
      !status &&
      (await this.client.connection.getBlockHeight("finalized")) > pending.lastValidBlockHeight
    ) {
      delete this.state.pending;
      this.save();
      return;
    }
    throw new Error("Pending signature unresolved; no new transaction will be signed");
  }
  async send(instructions: TransactionInstruction[], cancel = false, guard = () => true) {
    if (!guard()) throw new Error("Execution reference expired or shutdown requested");
    if (this.state.pending) throw new Error("Resolve pending transaction before signing another");
    const today = new Date().toISOString().slice(0, 10);
    if (today < this.state.day) throw new Error("Clock rollback");
    if (today !== this.state.day) {
      this.state.day = today;
      this.state.spent = "0";
      this.save();
    }
    const built = await this.client.prepareTransaction(
      this.wallet.publicKey,
      envelope(instructions, this.client.program),
      { pinWalletFees: true },
    );
    built.transaction.sign([this.wallet]);
    const balance = await this.client.connection.getBalance(this.wallet.publicKey, "confirmed");
    if (!Number.isSafeInteger(balance) || balance < 0)
      throw new Error("Unsafe SOL balance precision");
    const simulation = await this.client.connection.simulateTransaction(built.transaction, {
      sigVerify: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [this.wallet.publicKey.toBase58()] },
    });
    const after = simulation.value.accounts?.[0]?.lamports;
    if (simulation.value.err || !Number.isSafeInteger(after) || after! > balance)
      throw new Error("Local transaction simulation failed");
    const cost = BigInt(balance - after!),
      reserve = cancel ? 1_000_000n : BigInt(this.settings.minSolLamports);
    if (
      BigInt(after!) < reserve ||
      (cancel && cost > 50_000n) ||
      (!cancel && BigInt(this.state.spent) + cost > BigInt(this.settings.dailySolBudgetLamports))
    )
      throw new Error("SOL rent/fee budget or emergency reserve reached");
    if (!guard()) throw new Error("Execution reference expired during simulation");
    // Public signature is known before submission. Never retry with a fresh salt/blockhash after an ambiguous response.
    const signature = bs58.encode(built.transaction.signatures[0]!);
    this.state.pending = { signature, lastValidBlockHeight: built.lastValidBlockHeight };
    this.state.spent = String(BigInt(this.state.spent) + cost);
    this.save();
    const returned = await this.client.connection.sendRawTransaction(
      built.transaction.serialize(),
      { skipPreflight: false, maxRetries: 2 },
    );
    if (returned !== signature) throw new Error("Unexpected RPC transaction signature");
    const confirmed = await this.client.connection.confirmTransaction(
      { ...built, signature },
      "confirmed",
    );
    this.state.lastSlot = Math.max(this.state.lastSlot, confirmed.context.slot);
    delete this.state.pending;
    this.save();
    if (confirmed.value.err) throw new Error("Transaction rejected on chain");
    console.log(JSON.stringify({ event: cancel ? "cancelled" : "submitted", signature }));
  }
}
