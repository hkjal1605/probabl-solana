/** Devnet asset faucet. A dedicated, separately funded wallet (never the
 * deployer or any governance key) sends every signed-in wallet a small, fixed
 * amount of each devnet asset exactly once, so ~100 users can test with the
 * mock tokens. Claims are serialized, resumable per asset, and rate limited. */
import {
  key,
  type SolanaClient,
  supportedMint,
} from "@conditional-stocks/solana-client";
import { DEVNET_ASSET_MINTS } from "@conditional-stocks/shared/spot-prices";
import { ISSUER_TOKEN_CATALOG } from "@conditional-stocks/shared/token-catalog";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  type Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { HTTPException } from "hono/http-exception";

/** Whole units per claim (≈100 claims from the funded supply). */
export const FAUCET_AMOUNTS: Readonly<Record<string, string>> = Object.freeze({
  SOL: "0.02", // native, for the user's own transaction fees and account rent
  USDC: "500",
  BTC: "0.005",
  ETH: "0.1",
  NVDAx: "1",
  NVDAon: "1",
  TSLAx: "1",
  TSLAon: "1",
  SPYx: "0.5",
  SPYon: "0.5",
  OPENAI: "0.5",
  tOpenAI: "0.5",
  SPACEX: "5",
  tSpaceX: "1",
  KALSHI: "0.5",
  tKalshi: "1",
  ANTHROPIC: "0.5",
});
/** Assets per transaction: ATA creation + transfer each, within the packet limit. */
export const FAUCET_BATCH = 5;
export const FAUCET_HOURLY_CLAIMS = 60;
/** SOL the faucet keeps for its own fees and the users' token-account rent. */
const RENT_RESERVE_LAMPORTS = 60_000_000n;

export interface FaucetAsset {
  symbol: string;
  /** null for native SOL. */
  mint: PublicKey | null;
}

/** Native SOL, the quote/crypto mocks, then every configured issuer replica. */
export function faucetAssets(replicas: Readonly<Record<string, string>>): FaucetAsset[] {
  const assets: FaucetAsset[] = [
    { symbol: "SOL", mint: null },
    { symbol: "USDC", mint: key(DEVNET_ASSET_MINTS.USDC) },
    { symbol: "BTC", mint: key(DEVNET_ASSET_MINTS.BTC) },
    { symbol: "ETH", mint: key(DEVNET_ASSET_MINTS.ETH) },
  ];
  for (const token of ISSUER_TOKEN_CATALOG)
    if (replicas[token.symbol]) assets.push({ symbol: token.symbol, mint: key(replicas[token.symbol]!) });
  return assets.filter((asset) => FAUCET_AMOUNTS[asset.symbol] !== undefined);
}

/** Exact raw amount of a whole-unit decimal string. */
export function rawUnits(whole: string, decimals: number): bigint {
  const [integer = "0", fraction = ""] = whole.split(".");
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction) || fraction.length > decimals)
    throw new Error(`Invalid faucet amount ${whole}`);
  return BigInt(integer + fraction.padEnd(decimals, "0"));
}

/** Pending assets in transaction-sized batches (native SOL first). */
export function faucetBatches(assets: FaucetAsset[], delivered: readonly string[], size = FAUCET_BATCH) {
  const pending = assets.filter((asset) => !delivered.includes(asset.symbol));
  const batches: FaucetAsset[][] = [];
  for (let i = 0; i < pending.length; i += size) batches.push(pending.slice(i, i + size));
  return batches;
}

/** `locked` serializes claims; deliveries are written outside that transaction
 * (autocommit) so a later failure never rolls back transfers that already landed. */
export interface FaucetStore extends FaucetQueries {
  locked<T>(lock: string, work: (queries: FaucetQueries) => Promise<T>): Promise<T>;
}
interface FaucetClaim {
  delivered: string[];
  signatures: string[];
  completedAt: Date | null;
}
interface FaucetQueries {
  faucetClaim(domain: string, owner: string): Promise<FaucetClaim | undefined>;
  recordFaucetDelivery(domain: string, owner: string, delivered: string[], signature: string | null, complete: boolean): Promise<void>;
  faucetClaimsSince(domain: string, seconds: number): Promise<number>;
}

export class Faucet {
  private mints = new Map<string, { program: PublicKey; decimals: number }>();
  constructor(
    private client: SolanaClient,
    private signer: Keypair,
    private db: FaucetStore,
    private domain: string,
    private assets: FaucetAsset[],
  ) {}

  get address() {
    return this.signer.publicKey.toBase58();
  }

  async status(owner: string) {
    const claim = await this.db.faucetClaim(this.domain, key(owner).toBase58());
    return { available: true, claimed: Boolean(claim?.completedAt), faucet: this.address };
  }

  private async mint(asset: FaucetAsset) {
    const cached = this.mints.get(asset.symbol);
    if (cached) return cached;
    const metadata = await supportedMint(this.client.connection, asset.mint!);
    const value = { program: metadata.program, decimals: metadata.decimals };
    this.mints.set(asset.symbol, value);
    return value;
  }

  private async confirm(signature: string, lastValidBlockHeight: number) {
    const connection = this.client.connection;
    for (;;) {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) throw new Error("A faucet transfer failed on chain. Please try again.");
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
      if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        // Expired blockhash: it can no longer land, but it may have just before.
        const final = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (final && !final.err) return;
        throw new Error("A faucet transfer did not confirm in time. Please try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /** Transfers every not-yet-delivered asset to `ownerString`, once per wallet. */
  async claim(ownerString: string) {
    const owner = key(ownerString);
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error("Claims go to a wallet address, not a program account");
    const faucet = this.signer.publicKey;
    if (owner.equals(faucet)) throw new Error("The faucet cannot claim from itself");
    return this.db.locked(`faucet:${this.domain}`, async (queries) => {
      const previous = await queries.faucetClaim(this.domain, owner.toBase58());
      if (previous?.completedAt) throw new HTTPException(409, { message: "Devnet assets were already claimed for this wallet" });
      if (!previous && (await queries.faucetClaimsSince(this.domain, 3600)) >= FAUCET_HOURLY_CLAIMS)
        throw new HTTPException(429, { message: "The devnet faucet is busy. Please try again in a few minutes." });
      const connection = this.client.connection;
      if (BigInt(await connection.getBalance(faucet, "confirmed")) < rawUnits(FAUCET_AMOUNTS.SOL!, 9) + RENT_RESERVE_LAMPORTS)
        throw new HTTPException(503, { message: "The devnet faucet is out of SOL. Please try again later." });
      const delivered = [...(previous?.delivered ?? [])];
      const signatures = [...(previous?.signatures ?? [])];
      const sent: { symbol: string; amount: string }[] = [];
      const unavailable: string[] = [];
      const batches = faucetBatches(this.assets, delivered);
      for (const batch of batches) {
        const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })];
        const included: string[] = [];
        for (const asset of batch) {
          const amount = FAUCET_AMOUNTS[asset.symbol]!;
          if (!asset.mint) {
            instructions.push(SystemProgram.transfer({ fromPubkey: faucet, toPubkey: owner, lamports: rawUnits(amount, 9) }));
            included.push(asset.symbol);
            continue;
          }
          const { program, decimals } = await this.mint(asset);
          const raw = rawUnits(amount, decimals);
          const source = getAssociatedTokenAddressSync(asset.mint, faucet, false, program);
          const info = await connection.getAccountInfo(source, "confirmed");
          if (!info || unpackAccount(source, info, program).amount < raw) {
            unavailable.push(asset.symbol); // Run dry: skip, never fail everyone else's assets.
            continue;
          }
          const destination = getAssociatedTokenAddressSync(asset.mint, owner, false, program);
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(faucet, destination, owner, asset.mint, program),
            createTransferCheckedInstruction(source, asset.mint, destination, faucet, raw, decimals, [], program),
          );
          included.push(asset.symbol);
        }
        if (!included.length) continue;
        const latest = await connection.getLatestBlockhash("confirmed");
        const transaction = new VersionedTransaction(
          new TransactionMessage({ payerKey: faucet, recentBlockhash: latest.blockhash, instructions }).compileToV0Message(),
        );
        transaction.sign([this.signer]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
        await this.confirm(signature, latest.lastValidBlockHeight);
        delivered.push(...included);
        signatures.push(signature);
        await this.db.recordFaucetDelivery(this.domain, owner.toBase58(), included, signature, false);
        for (const symbol of included) sent.push({ symbol, amount: FAUCET_AMOUNTS[symbol]! });
      }
      if (!sent.length && !delivered.length)
        throw new HTTPException(503, { message: "The devnet faucet is empty. Please try again later." });
      await this.db.recordFaucetDelivery(this.domain, owner.toBase58(), [], null, true);
      return { owner: owner.toBase58(), sent, unavailable, signatures };
    });
  }
}
