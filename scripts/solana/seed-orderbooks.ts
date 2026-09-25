/** Devnet only. One-shot order-book seeding from the dedicated market-maker
 * wallet: rest SEED_LEVELS bids and SEED_LEVELS asks at random levels and sizes
 * on both branch books (YES and NO) of every open market. Bids accept every
 * listed issuer leg; asks rotate across legs. Orders expire at the market's
 * trading cutoff (the latest expiry the program accepts) and are never
 * repriced. Run with the bot's env file on its host; the key never leaves it:
 *
 *   bun --env-file=.local/ec2/env/market-maker.env scripts/solana/seed-orderbooks.ts --execute
 *
 * Re-running tops up only ladders that hold fewer than SEED_LEVELS own orders.
 */
import {
  baseRaw,
  big,
  claimAsset,
  digest,
  envelope,
  key,
  legBit,
  liveLegs,
  type LiveLeg,
  type MarketAccount,
  type OrderWire,
  orderSalt,
  planOrder,
  quote,
  SolanaClient,
  traderAddress,
  underlyingAsset,
} from "@conditional-stocks/solana-client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { signer } from "../../services/market-maker/src/execution.ts";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
if (!process.argv.includes("--execute")) throw new Error("Order-book seeding requires --execute");
if (required("MM_GENESIS_HASH") !== GENESIS) throw new Error("Devnet only");
const LEVELS = Number(process.env.SEED_LEVELS ?? 10);
const CONCURRENCY = Number(process.env.SEED_CONCURRENCY ?? 2);
// Placements per transaction (falls back to one when a bundle does not fit).
const BATCH = Number(process.env.SEED_BATCH ?? 4);
if (!Number.isInteger(LEVELS) || LEVELS < 1 || LEVELS > 20) throw new Error("Invalid SEED_LEVELS");
const api = new URL(process.env.MM_API_ORIGIN ?? "https://api-solana.probabl.trade").origin;
const wallet = signer(required("MM_PRIVATE_KEY"), required("MM_WALLET_ADDRESS"));
const owner = wallet.publicKey;
const client = new SolanaClient({
  rpcUrl: required("MM_RPC_URL"),
  config: required("MM_SOLANA_CONFIG"),
  genesisHash: GENESIS,
  addressLookupTables: (process.env.SOLANA_ADDRESS_LOOKUP_TABLES ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  ...(process.env.MM_PROGRAM_ID ? { programId: process.env.MM_PROGRAM_ID } : {}),
});
await client.assertNetwork();
const config = await client.configAccount();
if ([config.admin, config.seed_authority, ...Object.values(config.roles)].some((p) => p.equals(owner)))
  throw new Error("Seeding must use a separate, non-governance wallet");

const json = async <T>(path: string): Promise<T> => {
  const response = await fetch(new URL(path, api), { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
};
/** Deterministic per-market randomness (mulberry32 over the market id's
 * digest): a re-run reproduces the same levels and sizes, so topping up a
 * partially seeded book can never cross its existing orders. */
function randomFor(id: string) {
  const hash = digest(`seed-orderbooks:${id}`);
  let state = new DataView(hash.buffer, hash.byteOffset, 4).getUint32(0);
  return (low: number, high: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return low + (high - low) * (((t ^ (t >>> 14)) >>> 0) / 2 ** 32);
  };
}
const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rateLimited = (error: unknown) => /429|rate limit/i.test(String(error instanceof Error ? error.message : error));
/** Retry RPC reads through the shared endpoint's rate limit. */
async function rpc<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++)
    try {
      return await read();
    } catch (error) {
      if (!rateLimited(error) || attempt >= 8) throw error;
      await sleep(2_000 * attempt);
    }
}
async function landed(signature: string, lastValidBlockHeight: number) {
  while (true) {
    const status = (
      await rpc(() => client.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
    ).value[0];
    if (status?.err) throw new Error(`Transaction failed on chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return true;
    if ((await rpc(() => client.connection.getBlockHeight("confirmed"))) > lastValidBlockHeight) return false;
    await sleep(1_500);
  }
}
async function send(label: string, instructions: TransactionInstruction[]) {
  let previous: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const built = await rpc(() => client.prepareTransaction(owner, envelope(instructions, client.program)));
    built.transaction.sign([wallet]);
    const signature = bs58.encode(built.transaction.signatures[0]!);
    try {
      await rpc(() => client.connection.sendRawTransaction(built.transaction.serialize(), { maxRetries: 3 }));
    } catch (error) {
      const logs = ((error as { logs?: string[] }).logs ?? []).filter((line) => !line.includes("ComputeBudget"));
      // A resend of the identical instructions finding its accounts already
      // created means an earlier attempt landed after all.
      if (previous && logs.some((line) => line.includes("already in use"))) return previous;
      // Simulation rejected it: nothing landed.
      if (attempt >= 3)
        throw new Error(`${label}: ${error instanceof Error ? error.message.split("\n")[1] ?? error.message : error} | ${logs.slice(-6).join(" | ")}`);
      await sleep(2_000 * attempt);
      continue;
    }
    // A landed transaction is never resent; only an expired blockhash retries.
    previous = signature;
    if (await landed(signature, built.lastValidBlockHeight)) {
      await sleep(250);
      return signature;
    }
    if (attempt >= 3) throw new Error(`${label}: blockhash expired`);
  }
}

interface Planned {
  branch: 0 | 1;
  side: 0 | 1;
  bases: number;
  price: bigint;
  quantity: bigint;
}
/** Random ladders around the first leg's share price. */
function ladders(
  random: (low: number, high: number) => number,
  m: MarketAccount,
  legs: Record<number, LiveLeg>,
  center: number,
  existing: Map<string, number>,
  notional: [number, number],
) {
  const shareDecimals = m.terms.share_decimals,
    quoteDecimals = m.decimals[0]!,
    tick = big(m.terms.tick),
    step = big(m.terms.step),
    minNotional = big(m.terms.min_notional);
  const toPrice = (usd: number, up: boolean) => {
    const raw = BigInt(Math.round(usd * 10 ** (quoteDecimals - shareDecimals) * 1e6)) * 10n ** 12n;
    const ticks = raw / tick + (up && raw % tick !== 0n ? 1n : 0n);
    return (ticks < 1n ? 1n : ticks) * tick;
  };
  const tradable = Array.from({ length: m.bases }, (_, i) => i + 1).filter((c) => legs[c]?.tradable);
  if (!tradable.length) throw new Error("No tradable issuer leg");
  const bidMask = tradable.reduce((mask, c) => mask | legBit(c), 0);
  const planned: Planned[] = [];
  for (const branch of [0, 1] as const) {
    const mid = center * (1 + random(-0.03, 0.03)),
      half = random(0.004, 0.012);
    for (const side of [0, 1] as const) {
      let distance = half;
      const have = existing.get(`${branch}:${side}`) ?? 0;
      for (let level = 0; level < LEVELS; level++) {
        distance += random(0.002, 0.015);
        const size = random(...notional);
        if (level < have) continue;
        const usd = side === 0 ? mid * (1 - distance) : mid * (1 + distance);
        const price = toPrice(usd, side === 1);
        let quantity = (BigInt(Math.floor((size / usd) * 10 ** shareDecimals)) / step) * step;
        if (quantity < step) quantity = step;
        while (quote(quantity, price) < minNotional) quantity += step;
        planned.push({
          branch,
          side,
          bases: side === 0 ? bidMask : legBit(tradable[level % tradable.length]!),
          price,
          quantity,
        });
      }
    }
  }
  return planned;
}

async function seedMarket(id: string) {
  const marketKey = key(id);
  let m = await rpc(() => client.market(marketKey));
  if (m.state !== 2) return log("skipped", { market: id, state: m.state });
  const legs = await rpc(() => liveLegs(client.connection, m, client.config, client.program));
  const spots = await json<{ bases: { collateral: number; mint: string; sharePriceUsd: number | null; spot: { priceUsd: number | null } | null; multiplierValue: number | null }[] }>(
    `/v1/markets/${id}/spot-prices`,
  );
  const reference = spots.bases.toSorted((a, b) => a.collateral - b.collateral)[0];
  // Share price of the reference leg; plain SPL legs (crypto) trade one token per share.
  const spot = reference?.spot?.priceUsd ?? null;
  const center = reference?.sharePriceUsd ?? (spot && reference?.multiplierValue ? spot / reference.multiplierValue : spot);
  if (!center || !Number.isFinite(center) || center <= 0) return log("skipped", { market: id, reason: "no reference price" });
  const book = await json<{ orders: { id: string; maker: string; branch: number; side: number; status: string }[] }>(`/orderbook/${id}?limit=2000`);
  const own = book.orders.filter((order) => order.maker === owner.toBase58() && order.status === "open");
  const existing = new Map<string, number>();
  if (process.env.SEED_RESET === "1") {
    // Cancel this wallet's resting orders first (releasing their reservations).
    for (let i = 0; i < own.length; i += 8)
      await send(`${id}:cancel`, [
        client.orderMaintenance("cancel_orders", marketKey, owner, own.slice(i, i + 8).map((order) => key(order.id))),
      ]);
    if (own.length) log("cancelled", { market: id, orders: own.length });
  } else
    for (const order of own)
      existing.set(`${order.branch}:${order.side}`, (existing.get(`${order.branch}:${order.side}`) ?? 0) + 1);
  const native = m.bases >= 1 && m.mints[underlyingAsset(1)]!.equals(NATIVE_MINT);
  const planned = ladders(randomFor(id), m, legs, center, existing, native ? [2, 10] : [10, 100]);
  if (!planned.length) return log("complete", { market: id, placed: 0 });

  // Funding: one complete-set split per collateral covers both branch books.
  const current = await rpc(() => client.wallet(marketKey, owner));
  const setup: TransactionInstruction[] = current ? [] : [client.initializeWallet(marketKey, owner)];
  const balance = (asset: number) => (current ? big(current.balances[asset]!) : 0n);
  for (let collateral = 0; collateral <= m.bases; collateral++) {
    let deficit = 0n;
    for (const branch of [0, 1] as const) {
      const need = planned
        .filter((o) => o.branch === branch && (collateral === 0 ? o.side === 0 : o.side === 1 && o.bases === legBit(collateral)))
        .reduce(
          (sum, o) =>
            sum + (collateral === 0 ? quote(o.quantity, o.price, true) : baseRaw(o.quantity, legs[collateral]!.scale, legs[collateral]!.multiplier, true)),
          0n,
        );
      const short = need - balance(claimAsset(collateral, branch));
      if (short > deficit) deficit = short;
    }
    if (deficit === 0n) continue;
    deficit += deficit / 100n + 1n;
    const mint = m.mints[underlyingAsset(collateral)]!;
    const instructions = [...setup.splice(0)];
    if (mint.equals(NATIVE_MINT)) {
      const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
      const deposit = await client.depositForCredit(marketKey, owner, mint, underlyingAsset(collateral), deficit);
      await send(`${id}:wrap`, [
        createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: deposit.gross }),
        createSyncNativeInstruction(ata),
      ]);
    }
    const deposit = await client.depositForCredit(marketKey, owner, mint, underlyingAsset(collateral), deficit);
    instructions.push(
      deposit.instruction,
      client.positionCredit(marketKey, owner, collateral),
      client.position("split", marketKey, owner, collateral, deficit),
    );
    await send(`${id}:fund:${collateral}`, instructions);
    log("funded", { market: id, collateral, raw: String(deficit) });
  }
  if (setup.length) await send(`${id}:wallet`, setup);

  const traderKey = traderAddress(client.config, owner, client.program);
  const nonce = (await rpc(() => client.connection.getAccountInfo(traderKey)))
    ? big((await rpc(() => client.fetch<{ minimum_nonce: Parameters<typeof big>[0] }>("Trader", traderKey))).minimum_nonce)
    : 0n;
  // Every placement advances its branch's sequence by exactly one; track it
  // locally and re-read the market only when a bundle fails.
  m = await rpc(() => client.market(marketKey));
  const sequence = [big(m.sequence[0]!), big(m.sequence[1]!)];
  const build = (o: Planned, offset: bigint) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const order: OrderWire = {
      maker: owner.toBase58(),
      recipient: owner.toBase58(),
      marketId: id,
      salt: orderSalt(nonce, digest(crypto.randomUUID())),
      quantity: String(o.quantity),
      limitPriceRawX18: String(o.price),
      // Resting until filled: the latest expiry the program accepts.
      expiry: String(big(m.terms.trading_cutoff)),
      nonce: String(nonce),
      maxFeeBps: config.maker_bps,
      branch: o.branch,
      side: o.side,
      fundingKind: 1,
      tif: 0,
      bases: o.bases,
    };
    const plan = planOrder({
      order,
      candidates: [],
      now,
      step: big(m.terms.step),
      nextSequence: sequence[o.branch]! + offset,
      makerFeeBps: config.maker_bps,
      takerFeeBps: config.taker_bps,
      program: client.program,
      legs,
    });
    return client.placement(order, plan, m);
  };
  let placed = 0,
    batch = BATCH;
  for (const branch of [0, 1] as const) {
    const orders = planned.filter((o) => o.branch === branch);
    for (let i = 0; i < orders.length; ) {
      const bundle = orders.slice(i, i + batch);
      try {
        await send(`${id}:orders`, bundle.map((o, j) => build(o, BigInt(j))));
      } catch (error) {
        if (batch > 1) {
          batch = 1; // Too large or rejected as a bundle: continue one by one.
          m = await rpc(() => client.market(marketKey));
          sequence[branch] = big(m.sequence[branch]!);
          continue;
        }
        throw error;
      }
      sequence[branch]! += BigInt(bundle.length);
      placed += bundle.length;
      i += bundle.length;
    }
  }
  log("complete", { market: id, placed, center });
}

const { markets } = await json<{ markets: { id: string; state: number }[] }>("/markets");
// Optional explicit subset (comma-separated market ids), e.g. a single trial market.
const only = process.env.SEED_MARKETS ? new Set(process.env.SEED_MARKETS.split(",").map((v) => v.trim())) : null;
const queue = markets
  .filter((market) => market.state === 2 && (!only || only.has(market.id)))
  .map((market) => market.id);
log("start", { markets: queue.length, levels: LEVELS, maker: owner.toBase58() });
let failures = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let id = queue.shift(); id; id = queue.shift())
      try {
        await seedMarket(id);
      } catch (error) {
        failures++;
        log("failed", { market: id, error: error instanceof Error ? error.message.slice(0, 1500) : String(error) });
      }
  }),
);
log("done", { failures, sol: (await client.connection.getBalance(owner, "confirmed")) / 1e9 });
if (failures) process.exitCode = 1;
