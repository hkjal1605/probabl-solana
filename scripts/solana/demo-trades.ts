/** Devnet only. Demo trading activity on one market from the administrator
 * wallet, through the same path as the UI: wallet sign-in, pool deposits, the
 * delegated trading grant, POST /v1/orders/prepare and POST /v1/trading/submit.
 * Small immediate-or-cancel orders (1% price bound) follow a random walk on the
 * YES and NO books, never leaving fewer than MIN_LEVELS levels on a side. Every
 * trade is verified: planned fills are against other makers, the taker order
 * filled as planned on chain, maker orders shrank by their fills, the admin's
 * quote and issuer claims moved by exactly the executed amounts, and the fills
 * reached the index the charts read.
 *
 *   DEMO_MARKET=<id> bun --env-file=.env.devnet scripts/solana/demo-trades.ts --execute
 */
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  allLegs,
  baseRaw,
  big,
  claimAsset,
  DELEGATE_TRADE,
  envelope,
  type Envelope,
  key,
  legBit,
  liveLegs,
  type LiveLeg,
  orderId,
  orderSalt,
  type OrderWire,
  parseAtomicPlan,
  parseOrder,
  SolanaClient,
  underlyingAsset,
} from "@conditional-stocks/solana-client";
import bs58 from "bs58";
import { assertDevnet, parseDeployer } from "./devnet-policy.ts";

if (!process.argv.includes("--execute")) throw new Error("Demo trading requires --execute");
const API = "https://api-solana.probabl.trade";
const ORIGIN = "http://localhost:3001";
const MARKET = process.env.DEMO_MARKET ?? "";
const TRADES = Number(process.env.DEMO_TRADES ?? 30);
const MIN_LEVELS = 5;
const MAX_NOTIONAL = 250; // USD per order, well inside the grant's 1,000 USDC.
const deployment = (await Bun.file(".local/devnet/deployment.json").json()) as {
  assets: { symbol: string; mint: string; program: string; decimals: number }[];
  config: string;
  genesisHash: string;
  programId: string;
};
const admin = parseDeployer(process.env.DEVNET_DEPLOYER_PRIVATE_KEY);
const owner = admin.publicKey.toBase58();
const client = new SolanaClient({
  rpcUrl: process.env.DEVNET_BROWSER_RPC_URL ?? process.env.DEVNET_RPC_URL ?? "",
  config: deployment.config,
  genesisHash: deployment.genesisHash,
  programId: deployment.programId,
  addressLookupTables: ["BJMmm3pT6CX3hQ1xK7sbrEQGf3xtpDvf4GpY52fB6EPs"],
});
await assertDevnet(client.connection);
await client.assertNetwork();

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const random = (low: number, high: number) => low + Math.random() * (high - low);
let token = "";
async function api<T>(path: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as T;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(3_000 * attempt);
      continue;
    }
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
}
async function confirm(signature: string) {
  for (let i = 0; i < 90; i++) {
    const status = (await client.connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await sleep(1_000);
  }
  throw new Error(`Transaction not confirmed: ${signature}`);
}
async function send(label: string, value: Envelope) {
  const built = await client.prepareTransaction(admin.publicKey, value);
  built.transaction.sign([admin]);
  const signature = await client.connection.sendRawTransaction(built.transaction.serialize(), { maxRetries: 5 });
  await confirm(signature);
  log("owner-transaction", { label, signature });
}

// 1. Wallet sign-in (the UI's challenge/verify session).
const challenge = await api<{ challengeId: string; message: string }>("/v1/auth/challenge", { address: owner, origin: ORIGIN });
const signature = sign(
  null,
  Buffer.from(challenge.message),
  createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(admin.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  }),
);
token = (await api<{ token: string }>("/v1/auth/verify", { address: owner, challengeId: challenge.challengeId, signature: bs58.encode(signature) })).token;
log("signed-in", { owner });
client.useLookupTables((await api<{ tables: string[] }>("/v1/lookup-tables")).tables);

const marketKey = key(MARKET);
let market = await client.market(marketKey);
if (market.state !== 2) throw new Error("Market is not open");
const legs = await liveLegs(client.connection, market, client.config, client.program);
const quoteMint = market.mints[0]!;
const legMints = Array.from({ length: market.bases }, (_, i) => market.mints[underlyingAsset(i + 1)]!);
const symbolOf = (mint: string) => deployment.assets.find((a) => a.mint === mint)?.symbol ?? mint.slice(0, 6);
log("market", { market: MARKET, legs: legMints.map((m) => symbolOf(m.toBase58())) });

// 2. Deposits into pool credit (fee-aware for issuer transfer fees).
const credit = async (mint: typeof quoteMint) => {
  const account = await client.assetCredit(mint, admin.publicKey);
  return account ? big(account.available) : 0n;
};
const targets: [typeof quoteMint, number][] = [[quoteMint, 5_000], ...legMints.map((m) => [m, 4] as [typeof quoteMint, number])];
for (const [mint, whole] of targets) {
  const asset = deployment.assets.find((a) => a.mint === mint.toBase58())!;
  const target = BigInt(Math.round(whole * 10 ** asset.decimals));
  const before = await credit(mint);
  if (before >= target / 2n) {
    log("deposit-skipped", { symbol: asset.symbol, credit: before });
    continue;
  }
  const gross = target - before;
  const quote = await client.withdrawalQuote(mint, gross);
  await send(`deposit-${asset.symbol}`, envelope([client.depositPool(admin.publicKey, mint, gross, key(asset.program), quote.received)], client.program));
  const after = await credit(mint);
  if (after - before !== quote.received) throw new Error(`${asset.symbol} credit rose by ${after - before}, expected ${quote.received}`);
  log("deposited", { symbol: asset.symbol, gross, credited: quote.received, transferFee: gross - quote.received });
}

// 3. Delegated trading grant (the UI's "Enable trading").
type Permission = { active: boolean; delegate: string | null; quoteDecimals: number | null; grant: null | { expiresAt: string } };
let permission = await api<Permission>(`/v1/trading/permission?owner=${owner}`);
if (!permission.active) {
  if (!permission.delegate || permission.quoteDecimals === null) throw new Error("Delegated trading is unavailable");
  if (permission.grant) throw new Error("An expired or exhausted grant exists; a new trading key is required");
  const unit = 10n ** BigInt(permission.quoteDecimals);
  await send(
    "enable-trading",
    envelope(
      [
        client.approveDelegate(admin.publicKey, key(permission.delegate), {
          market: null,
          expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 90n * 86_400n,
          maxOrderQuote: 1_000n * unit,
          totalQuote: 10_000n * unit,
          maxFeeBps: 100,
          permissions: DELEGATE_TRADE,
        }),
      ],
      client.program,
    ),
  );
  for (let i = 0; i < 30 && !permission.active; i++) {
    await sleep(2_000);
    permission = await api<Permission>(`/v1/trading/permission?owner=${owner}`);
  }
  if (!permission.active) throw new Error("Trading permission did not become active");
}
log("trading-enabled", { delegate: permission.delegate, expiresAt: permission.grant?.expiresAt });

type IndexedOrder = OrderWire & { id: string; remaining: string; status: string };
const book = async () =>
  (await api<{ orders: IndexedOrder[] }>(`/orderbook/${MARKET}?limit=2000`)).orders.filter(
    (o) => o.status === "open" && BigInt(o.remaining) > 0n && o.maker !== owner,
  );
const tradesCount = async () => (await api<{ trades: unknown[] }>(`/trades?marketId=${MARKET}&limit=1000`)).trades.length;
const walletBalances = async () => {
  const wallet = await client.wallet(marketKey, admin.publicKey);
  return (asset: number) => (wallet ? big(wallet.balances[asset]!) : 0n);
};

const tick = big(market.terms.tick),
  step = big(market.terms.step),
  minNotional = big(market.terms.min_notional);
const usd = (price: bigint) => Number(price) / 1e18;
const direction = [1, -1];
let failures = 0,
  completed = 0;
for (let n = 1; n <= TRADES; n++) {
  const branch = Math.random() < 0.5 ? 0 : 1;
  if (Math.random() < 0.35) direction[branch] = -direction[branch]!;
  let side = direction[branch]! > 0 ? 0 : 1; // buy lifts asks (price up), sell hits bids (price down)
  let orders = await book();
  const levels = (s: number) => new Set(orders.filter((o) => o.branch === branch && o.side === (s === 0 ? 1 : 0)).map((o) => o.limitPriceRawX18)).size;
  if (levels(side) < MIN_LEVELS) side = 1 - side;
  if (levels(side) < MIN_LEVELS) {
    log("skip", { n, reason: "thin book" });
    continue;
  }
  // Best opposite orders, best price first.
  const opposite = orders
    .filter((o) => o.branch === branch && o.side === (side === 0 ? 1 : 0))
    .sort((a, b) => {
      const d = BigInt(a.limitPriceRawX18) - BigInt(b.limitPriceRawX18);
      return (side === 0 ? d > 0n : d < 0n) ? 1 : d === 0n ? 0 : -1;
    });
  const best = opposite[0]!;
  const bestPrice = BigInt(best.limitPriceRawX18);
  // Mostly consume the whole best level (the price moves), sometimes part of
  // it, sometimes reaching into the next level.
  const roll = Math.random();
  const share = roll < 0.3 ? random(0.4, 0.9) : 1;
  const sweep = roll > 0.85 && opposite[1] ? (BigInt(opposite[1].remaining) * BigInt(Math.round(random(0.3, 0.6) * 1000))) / 1000n : 0n;
  let quantity = (((BigInt(best.remaining) * BigInt(Math.round(share * 1000))) / 1000n + sweep) / step) * step;
  const cap = (BigInt(Math.floor((MAX_NOTIONAL / usd(bestPrice)) * 1e6)) / step) * step;
  if (quantity > cap) quantity = cap;
  if (quantity < step) quantity = step;
  while ((quantity * bestPrice) / 10n ** 18n < minNotional) quantity += step;
  // Market order: 1% worst-price bound, immediate-or-cancel.
  const bound = side === 0 ? (bestPrice * 101n) / 100n : (bestPrice * 99n) / 100n;
  const limit = side === 0 ? ((bound + tick - 1n) / tick) * tick : (bound / tick) * tick;
  const sellCollateral = 1 + Math.floor(Math.random() * market.bases);
  const now = Date.now();
  const order = parseOrder({
    maker: owner,
    recipient: owner,
    delegate: permission.delegate!,
    marketId: MARKET,
    salt: orderSalt(BigInt(now), randomBytes(32)),
    quantity: quantity.toString(),
    limitPriceRawX18: limit.toString(),
    expiry: String(Math.min(Math.floor(now / 1000) + 30 * 86_400, Number(market.terms.trading_cutoff) - 1, Number(permission.grant!.expiresAt) - 1)),
    nonce: String(now),
    maxFeeBps: 100,
    branch,
    side,
    fundingKind: 0,
    tif: 1,
    bases: side === 0 ? allLegs(market.bases) : legBit(sellCollateral),
  });
  const label = `${n} ${branch === 0 ? "YES" : "NO"} ${side === 0 ? "buy" : "sell"}`;
  try {
    const review = await api<{ orderHash: string; plan: unknown }>("/v1/orders/prepare", { order });
    const plan = parseAtomicPlan(review.plan, order);
    if (review.orderHash !== orderId(order, client.program)) throw new Error("API order identity differs");
    if (BigInt(plan.filledQuantity) <= 0n) throw new Error("Plan fills nothing");
    if (plan.makers.some((m) => m.maker === owner)) throw new Error("Plan self-trades");
    const makerIds = plan.makers.map((m) => orderId(m, client.program));
    const makerBefore = await Promise.all(makerIds.map((id) => client.order(key(id)).then((o) => big(o.remaining))));
    // The funding collateral and branch assets this trade moves.
    const fillLegs = plan.makers.map((m) => (side === 0 ? Math.log2(m.bases) + 1 : sellCollateral));
    const legMint = (c: number) => market.mints[underlyingAsset(c)]!;
    const balances = await walletBalances();
    const quoteBefore = (await credit(quoteMint)) + balances(claimAsset(0, branch));
    const legBefore = new Map<number, bigint>();
    for (const c of new Set(fillLegs)) legBefore.set(c, (await credit(legMint(c))) + balances(claimAsset(c, branch)));
    const tradesBefore = await tradesCount();

    const submitted = await api<{ signature: string; orderHash: string }>("/v1/trading/submit", { order });
    await confirm(submitted.signature);

    // On chain: taker filled as planned; makers shrank by their planned fills.
    const taker = await client.order(key(review.orderHash)).catch(() => null);
    const filled = taker ? big(taker.filled) : null;
    const makerAfter = await Promise.all(makerIds.map((id) => client.order(key(id)).then((o) => big(o.remaining))));
    const makerFilled = makerBefore.map((b, i) => b - makerAfter[i]!);
    const totalMakerFill = makerFilled.reduce((a, b) => a + b, 0n);
    const problems: string[] = [];
    if (filled !== null && filled !== BigInt(plan.filledQuantity)) problems.push(`taker filled ${filled} != planned ${plan.filledQuantity}`);
    if (totalMakerFill !== BigInt(plan.filledQuantity)) problems.push(`makers filled ${totalMakerFill} != planned ${plan.filledQuantity}`);
    plan.quantities.forEach((q, i) => {
      if (makerFilled[i] !== BigInt(q)) problems.push(`maker ${i} filled ${makerFilled[i]} != ${q}`);
    });
    // Value: quote moved by exactly the execution quote; issuer claims by the
    // multiplier-converted share quantity (±1 raw per fill for rounding).
    const after = await walletBalances();
    const quoteAfter = (await credit(quoteMint)) + after(claimAsset(0, branch));
    const quoteDelta = side === 0 ? quoteBefore - quoteAfter : quoteAfter - quoteBefore;
    if (quoteDelta !== BigInt(plan.executionQuote)) problems.push(`quote moved ${quoteDelta} != execution ${plan.executionQuote}`);
    for (const c of new Set(fillLegs)) {
      const leg = legs[c] as LiveLeg;
      const shares = plan.quantities.reduce((sum, q, i) => (fillLegs[i] === c ? sum + BigInt(q) : sum), 0n);
      const expected = baseRaw(shares, big(leg.scale), leg.multiplier);
      const legAfter = (await credit(legMint(c))) + after(claimAsset(c, branch));
      const delta = side === 0 ? legAfter - legBefore.get(c)! : legBefore.get(c)! - legAfter;
      const fills = BigInt(fillLegs.filter((x) => x === c).length);
      if (delta < expected - fills || delta > expected + fills) problems.push(`leg ${c} claims moved ${delta}, expected ~${expected}`);
    }
    // Index: the fills reach /trades (what the price charts read).
    let indexed = await tradesCount();
    for (let i = 0; i < 20 && indexed < tradesBefore + plan.quantities.length; i++) {
      await sleep(1_500);
      indexed = await tradesCount();
    }
    if (indexed < tradesBefore + plan.quantities.length) problems.push(`index shows ${indexed - tradesBefore} of ${plan.quantities.length} fills`);
    const averagePrice = Number(BigInt(plan.executionQuote) * 10n ** 6n / BigInt(plan.filledQuantity)) / 1e6;
    if (problems.length) failures++;
    else completed++;
    log(problems.length ? "trade-mismatch" : "trade-verified", {
      trade: label,
      shares: Number(plan.filledQuantity) / 1e6,
      fills: plan.quantities.length,
      legs: [...new Set(fillLegs)].map((c) => symbolOf(legMint(c).toBase58())),
      bestPrice: usd(bestPrice),
      averagePrice,
      quoteUsd: Number(plan.executionQuote) / 1e6,
      signature: submitted.signature,
      ...(problems.length ? { problems } : {}),
    });
  } catch (error) {
    failures++;
    log("trade-failed", { trade: label, error: error instanceof Error ? error.message.slice(0, 400) : String(error) });
  }
  market = await client.market(marketKey);
  if (n < TRADES) await sleep(random(15_000, 40_000));
}
const finalOrders = await book();
const top = (branch: number, side: number) => {
  const prices = finalOrders.filter((o) => o.branch === branch && o.side === side).map((o) => usd(BigInt(o.limitPriceRawX18)));
  return prices.length ? (side === 0 ? Math.max(...prices) : Math.min(...prices)) : null;
};
log("done", {
  verified: completed,
  failures,
  indexedTrades: await tradesCount(),
  yes: { bid: top(0, 0), ask: top(0, 1) },
  no: { bid: top(1, 0), ask: top(1, 1) },
});
if (failures) process.exitCode = 1;
