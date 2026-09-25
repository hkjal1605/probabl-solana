/** Devnet only. Fund the API's dedicated faucet wallet from the administrator:
 * FAUCET_CLAIMS × each per-claim token amount, plus FAUCET_SOL native SOL.
 * Tops up to the target, so re-running only sends what is missing.
 *
 *   FAUCET_ADDRESS=<pubkey> bun --env-file=.env.devnet scripts/solana/fund-faucet.ts --execute
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  unpackAccount,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { FAUCET_AMOUNTS, faucetAssets, rawUnits } from "../../apps/api/src/solana/faucet/faucet.ts";
import { parseReplicaMints } from "../../packages/shared/src/token-catalog.ts";
import { assertDevnet, parseDeployer } from "./devnet-policy.ts";

if (!process.argv.includes("--execute")) throw new Error("Funding the faucet requires --execute");
const CLAIMS = BigInt(process.env.FAUCET_CLAIMS ?? 105);
const SOL = rawUnits(process.env.FAUCET_SOL ?? "5", 9);
const faucet = new PublicKey(process.env.FAUCET_ADDRESS ?? "");
const admin = parseDeployer(process.env.DEVNET_DEPLOYER_PRIVATE_KEY);
const connection = new Connection(process.env.DEVNET_RPC_URL ?? "", "confirmed");
await assertDevnet(connection);
const replicas = (await (await fetch("https://api-solana.probabl.trade/v1/tokens/replicas")).json()) as {
  replicas: Record<string, string>;
};
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function send(instructions: TransactionInstruction[], label: string) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new VersionedTransaction(
    new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message(),
  );
  transaction.sign([admin]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 5 });
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error(`${label} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
    if ((await connection.getBlockHeight("confirmed")) > latest.lastValidBlockHeight)
      throw new Error(`${label} expired: ${signature}`);
    await Bun.sleep(1_000);
  }
  log("sent", { label, signature });
}

let pending: TransactionInstruction[] = [];
let labels: string[] = [];
const flush = async () => {
  if (pending.length) await send(pending, labels.join(","));
  pending = [];
  labels = [];
};
for (const asset of faucetAssets(parseReplicaMints(Object.entries(replicas.replicas).map(([k, v]) => `${k}=${v}`).join(",")))) {
  if (!asset.mint) continue;
  const info = await connection.getAccountInfo(asset.mint, "confirmed");
  if (!info) throw new Error(`Missing mint for ${asset.symbol}`);
  const program = info.owner;
  const { decimals } = await getMint(connection, asset.mint, "confirmed", program);
  const target = rawUnits(FAUCET_AMOUNTS[asset.symbol]!, decimals) * CLAIMS;
  const destination = getAssociatedTokenAddressSync(asset.mint, faucet, false, program);
  const existing = await connection.getAccountInfo(destination, "confirmed");
  const held = existing ? unpackAccount(destination, existing, program).amount : 0n;
  if (held >= target) {
    log("funded", { symbol: asset.symbol, held });
    continue;
  }
  const source = getAssociatedTokenAddressSync(asset.mint, admin.publicKey, false, program);
  pending.push(
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, destination, faucet, asset.mint, program),
    createTransferCheckedInstruction(source, asset.mint, destination, admin.publicKey, target - held, decimals, [], program),
  );
  labels.push(asset.symbol);
  if (labels.length === 5) await flush();
}
await flush();
const lamports = BigInt(await connection.getBalance(faucet, "confirmed"));
if (lamports < SOL)
  await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: faucet, lamports: SOL - lamports })], "SOL");
log("faucet", { address: faucet.toBase58(), sol: (await connection.getBalance(faucet, "confirmed")) / 1e9 });
