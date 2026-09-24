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
import {
  ASSETS,
  assertDevnet,
  isIssuer,
  marketLegs,
  MARKET_TICKERS,
  parseDeployer,
  rawAmount,
} from "./devnet-policy.ts";
import { DEVNET_MARKET_SEED } from "./seed-markets-policy.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CONFIG_PATH = resolve(ROOT, ".local/devnet/market-maker-all.json");
const PROGRAM = "53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra";
const CONFIG = "EfXom6mQxuw5gsHG4AujCgo1dQ3qWg5pN85RvY1ysn23";
const ADMIN = "4o2JYy6ktdZEfaUVHGwdCbvMyypZ1NRCDpyS1rfY9q8z";
const EXPECTED_MARKET_MAKER = "9wYFs5Qt7dXAnU5ewPAvG21ncYjbAeDzawvTtVFmdj5Z";
const API = "https://api-solana.probabl.trade";
// Wallet rent is ~0.0022 SOL per market, and every resting order is a rent-paying
// account (~0.002 SOL), across both branches and every issuer leg's asks.
const TARGET_SOL = 8_000_000_000n;
/** Wallet top-ups in whole tokens: quote plus every issuer leg of every asset. */
const TARGETS: Readonly<Record<string, string>> = Object.freeze({
  USDC: "6000",
  // SOL legs are wrapped by the bot from its own balance.
  BTC: "2",
  ETH: "5",
  ...Object.fromEntries(ASSETS.filter(isIssuer).map((leg) => [leg.symbol, "5"])),
});

/** Indexed market (protocolVersion 3): issuer legs in collateral order. */
interface IndexedMarket {
  bases: Array<{ collateral: number; mint: string }>;
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
// Funding only sends to the bot's public address; its key stays on the bot host.
const marketMaker = { publicKey: key(process.env.MM_WALLET_ADDRESS ?? EXPECTED_MARKET_MAKER) };
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
const asset = (symbol: string) => {
  const matches = deployment.assets.filter((value) => value.symbol === symbol);
  const match = matches[0];
  if (matches.length !== 1 || !match) throw new Error(`Missing unique ${symbol} fixture`);
  return match;
};
// One market per underlying asset and event, listing that asset's issuer legs in order.
const rows = MARKET_TICKERS.map((ticker) => marketLegs(ticker).map((leg) => asset(leg.symbol).mint));
const rowKey = (mints: string[]) => mints.join(",");
const expectedRows = new Map(rows.map((mints, index) => [rowKey(mints), MARKET_TICKERS[index]!]));
const quote = asset("USDC");

const response = await fetch(`${API}/markets`, {
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Market index returned ${response.status}`);
const body = (await response.json()) as { markets?: IndexedMarket[] };
if (!Array.isArray(body.markets)) throw new Error("Invalid market index");
// Frozen markets (removed from the demo catalogue) are never quoted.
const markets = body.markets.filter((market) => market.state !== 3);
if (markets.length !== DEVNET_MARKET_SEED.reduce((sum, seed) => sum + seed.tickers.length, 0))
  throw new Error("Indexer does not expose exactly the intended fresh market catalogue");
const seeds = new Map(DEVNET_MARKET_SEED.map((entry) => [entry.slug, entry]));
const groups = new Map<string, Set<string>>();
const legsOf = (market: IndexedMarket) =>
  market.bases.toSorted((a, b) => a.collateral - b.collateral).map((leg) => leg.mint);
for (const market of markets) {
  const slug = new URL(market.metadataUri).pathname.split("/").filter(Boolean).at(-1);
  const ticker = Array.isArray(market.bases) ? expectedRows.get(rowKey(legsOf(market))) : undefined;
  if (
    market.state !== 2 ||
    market.quoteToken !== quote.mint ||
    !ticker ||
    !slug ||
    !seeds.get(slug)?.tickers.includes(ticker as (typeof MARKET_TICKERS)[number])
  )
    throw new Error(`Unexpected indexed market ${market.id}`);
  const group = groups.get(market.polymarketConditionId) ?? new Set<string>();
  if (group.has(ticker)) throw new Error("Duplicate asset in one event group");
  group.add(ticker);
  groups.set(market.polymarketConditionId, group);
}
if (
  groups.size !== DEVNET_MARKET_SEED.length ||
  [...groups.values()].some((group) => group.size !== 3)
)
  throw new Error("Indexed event grouping is incomplete");

const config = settings({
  markets: markets
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((market) => {
      // baseMints exactly equal the listed legs in leg order; the first
      // (xStocks) leg is the price reference of multi-leg markets.
      const baseMints = legsOf(market);
      return {
        market: market.id,
        baseMints,
        quoteMint: market.quoteToken,
        baseInventories: baseMints.map(() => "0.2"),
        quoteInventory: "100",
        orderQuote: "20",
        gapBps: 1000,
        basePriceMultipliers: baseMints.map(() => "1"),
        quotePriceMultiplier: "1",
        ...(baseMints.length > 1 ? { referenceMints: [baseMints[0]!] } : {}),
      };
    }),
  allowStaleDevnetSpot: true,
  quoteLevels: 10,
  levelSpacingBps: 30,
  halfSpreadBps: 75,
  adverseSelectionBps: 25,
  maxHalfSpreadBps: 500,
  repriceBps: 20,
  ttlSeconds: 86400,
  pollMs: 15000,
  cutoffBufferSeconds: 300,
  maxFeedAgeMs: 900000,
  maxProbabilitySpreadX6: 200000,
  probabilityFloorX6: 20000,
  jumpBps: 500,
  probabilityJumpX6: 100000,
  cooldownMs: 60000,
  maxDrawdownBps: 1000,
  // PreStocks OPENAI/KALSHI/ANTHROPIC charge the mainnet 3% transfer fee.
  maxTransferFeeBps: 300,
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
  for (const [symbol, amount] of Object.entries(TARGETS)) {
    const fixture = asset(symbol);
    const mint = key(fixture.mint);
    const program = key(fixture.program);
    const source = getAssociatedTokenAddressSync(mint, admin.publicKey, false, program);
    const destination = getAssociatedTokenAddressSync(mint, marketMaker.publicKey, false, program);
    const destinationInfo = await connection.getAccountInfo(destination, "confirmed");
    const current = destinationInfo
      ? unpackAccount(destination, destinationInfo, program).amount
      : 0n;
    const target = rawAmount(amount, fixture.decimals);
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
