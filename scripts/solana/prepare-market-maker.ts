import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  currentTransferFee,
  key,
  supportedMint,
  transferGross,
} from "@conditional-stocks/solana-client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import {
  Connection,
  type Keypair,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { settings } from "../../services/market-maker/src/config.ts";
import { signer } from "../../services/market-maker/src/execution.ts";
import { assertDevnet, parseDeployer, rawAmount } from "./devnet-policy.ts";
import { DEVNET_MARKET_SEED } from "./seed-markets-policy.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CONFIG_PATH = resolve(ROOT, ".local/devnet/market-maker-all.json");
const PROGRAM = "8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg";
const CONFIG = "6buYkVtSJjaoozCDsPFYrPhp5g1q1oLg2eLp7FpsZ1tF";
const ADMIN = "4o2JYy6ktdZEfaUVHGwdCbvMyypZ1NRCDpyS1rfY9q8z";
const EXPECTED_MARKET_MAKER = "9wYFs5Qt7dXAnU5ewPAvG21ncYjbAeDzawvTtVFmdj5Z";
const API = "https://api-solana.probabl.trade";
const TARGET_SOL = 8_000_000_000n;
const TARGETS = Object.freeze({ USDC: "5000", TSLA: "5", NVDA: "5", SPY: "5" });

interface IndexedMarket {
  baseToken: string;
  id: string;
  metadataUri: string;
  polymarketConditionId: string;
  quoteToken: string;
  state: number;
}

const execute = process.argv.includes("--execute");
const rpc = process.env.DEVNET_BROWSER_RPC_URL ?? process.env.DEVNET_RPC_URL;
if (!rpc) throw new Error("DEVNET_BROWSER_RPC_URL or DEVNET_RPC_URL is required");
const connection = new Connection(rpc, "confirmed");
await assertDevnet(connection);
const admin = parseDeployer(process.env.DEVNET_DEPLOYER_PRIVATE_KEY);
if (admin.publicKey.toBase58() !== ADMIN) throw new Error("Unexpected Devnet administrator");
const marketMaker = signer(process.env.MM_PRIVATE_KEY ?? "", process.env.MM_WALLET_ADDRESS ?? "");
if (
  marketMaker.publicKey.toBase58() !== EXPECTED_MARKET_MAKER ||
  marketMaker.publicKey.equals(admin.publicKey)
)
  throw new Error("Unexpected or governance market-maker wallet");

const deployment = JSON.parse(
  await Bun.file(resolve(ROOT, ".local/devnet/deployment.json")).text(),
) as {
  assets: Array<{ decimals: number; mint: string; program: string; symbol: string }>;
  config: string;
  programId: string;
};
if (deployment.programId !== PROGRAM || deployment.config !== CONFIG)
  throw new Error("Deployment record does not match the fresh Devnet program");
const asset = (symbol: keyof typeof TARGETS) => {
  const matches = deployment.assets.filter((value) => value.symbol === symbol);
  const match = matches[0];
  if (matches.length !== 1 || !match) throw new Error(`Missing unique ${symbol} fixture`);
  return match;
};
const bases = [asset("TSLA"), asset("NVDA"), asset("SPY")];
const quote = asset("USDC");

const response = await fetch(`${API}/markets`, {
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Market index returned ${response.status}`);
const body = (await response.json()) as { markets?: IndexedMarket[] };
const markets = body.markets;
if (!Array.isArray(markets) || markets.length !== DEVNET_MARKET_SEED.length * bases.length)
  throw new Error("Indexer does not expose exactly the intended fresh market catalogue");
const slugs = new Set(DEVNET_MARKET_SEED.map((entry) => entry.slug));
const groups = new Map<string, Set<string>>();
for (const market of markets) {
  const slug = new URL(market.metadataUri).pathname.split("/").filter(Boolean).at(-1);
  if (
    market.state !== 2 ||
    market.quoteToken !== quote.mint ||
    !bases.some((value) => value.mint === market.baseToken) ||
    !slug ||
    !slugs.has(slug)
  )
    throw new Error(`Unexpected indexed market ${market.id}`);
  const group = groups.get(market.polymarketConditionId) ?? new Set<string>();
  if (group.has(market.baseToken)) throw new Error("Duplicate base in one event group");
  group.add(market.baseToken);
  groups.set(market.polymarketConditionId, group);
}
if (
  groups.size !== DEVNET_MARKET_SEED.length ||
  [...groups.values()].some((group) => group.size !== bases.length)
)
  throw new Error("Indexed event grouping is incomplete");

const config = settings({
  markets: markets
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((market) => ({
      market: market.id,
      baseMint: market.baseToken,
      quoteMint: market.quoteToken,
      baseInventory: "0.2",
      quoteInventory: "100",
      orderQuote: "20",
      gapBps: 1000,
      basePriceMultiplier: "1",
      quotePriceMultiplier: "1",
    })),
  quoteLevels: 10,
  levelSpacingBps: 30,
  halfSpreadBps: 75,
  adverseSelectionBps: 25,
  maxHalfSpreadBps: 500,
  repriceBps: 20,
  ttlSeconds: 86400,
  pollMs: 15000,
  cutoffBufferSeconds: 300,
  maxFeedAgeMs: 30000,
  maxProbabilitySpreadX6: 50000,
  probabilityFloorX6: 20000,
  jumpBps: 500,
  probabilityJumpX6: 100000,
  cooldownMs: 60000,
  maxDrawdownBps: 1000,
  maxTransferFeeBps: 100,
  minSolLamports: "100000000",
  dailySolBudgetLamports: "10000000000",
});
mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, CONFIG_PATH);
chmodSync(CONFIG_PATH, 0o600);

async function send(label: string, payer: Keypair, instructions: TransactionInstruction[]) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message(),
  );
  transaction.sign([payer]);
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err)
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 5,
    preflightCommitment: "confirmed",
  });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "finalized");
  if (confirmation.value.err) throw new Error(`${label} failed on chain`);
  console.log(JSON.stringify({ event: "funded-wallet", label, signature }));
}

if (execute) {
  const currentSol = BigInt(await connection.getBalance(marketMaker.publicKey, "confirmed"));
  if (currentSol < TARGET_SOL) {
    const amount = TARGET_SOL - currentSol;
    const adminBalance = BigInt(await connection.getBalance(admin.publicKey, "confirmed"));
    if (adminBalance - amount < 2_000_000_000n)
      throw new Error("Admin SOL reserve would fall below 2 SOL");
    await send("SOL", admin, [
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: marketMaker.publicKey,
        lamports: amount,
      }),
    ]);
  }
  for (const symbol of Object.keys(TARGETS) as Array<keyof typeof TARGETS>) {
    const fixture = asset(symbol);
    const mint = key(fixture.mint);
    const program = key(fixture.program);
    const source = getAssociatedTokenAddressSync(mint, admin.publicKey, false, program);
    const destination = getAssociatedTokenAddressSync(mint, marketMaker.publicKey, false, program);
    const destinationInfo = await connection.getAccountInfo(destination, "confirmed");
    const current = destinationInfo
      ? unpackAccount(destination, destinationInfo, program).amount
      : 0n;
    const target = rawAmount(TARGETS[symbol], fixture.decimals);
    if (current >= target) continue;
    const mintInfo = await supportedMint(connection, mint);
    if (!mintInfo.program.equals(program) || mintInfo.decimals !== fixture.decimals)
      throw new Error(`${symbol} mint metadata changed`);
    const gross = transferGross(target - current, await currentTransferFee(connection, mintInfo));
    const sourceInfo = await connection.getAccountInfo(source, "confirmed");
    if (!sourceInfo || unpackAccount(source, sourceInfo, program).amount < gross)
      throw new Error(`Admin has insufficient ${symbol}`);
    await send(symbol, admin, [
      createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey,
        destination,
        marketMaker.publicKey,
        mint,
        program,
      ),
      createTransferCheckedInstruction(
        source,
        mint,
        destination,
        admin.publicKey,
        gross,
        fixture.decimals,
        [],
        program,
      ),
    ]);
  }
}

console.log(
  JSON.stringify({
    complete: true,
    execute,
    config: CONFIG_PATH,
    wallet: marketMaker.publicKey.toBase58(),
    markets: config.markets.length,
    quoteLevels: config.quoteLevels,
  }),
);
