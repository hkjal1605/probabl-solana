/** Devnet only. Close the administrator's claims in one market the way a user
 * would: merge matching YES/NO pairs of each issuer leg back into pool credit,
 * sell the one-sided leg remainder into the book through the delegated API
 * (claim-funded immediate-or-cancel), then merge the matching USDC claims.
 *
 *   DEMO_MARKET=<id> bun --env-file=.env.devnet scripts/solana/close-demo-positions.ts --execute
 */
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  baseRaw,
  big,
  claimAsset,
  envelope,
  type Envelope,
  key,
  legBit,
  liveLegs,
  orderId,
  orderSalt,
  type OrderWire,
  parseAtomicPlan,
  parseOrder,
  SolanaClient,
} from "@conditional-stocks/solana-client";
import bs58 from "bs58";
import { assertDevnet, parseDeployer } from "./devnet-policy.ts";

if (!process.argv.includes("--execute")) throw new Error("Closing positions requires --execute");
const API = "https://api-solana.probabl.trade";
const MARKET = process.env.DEMO_MARKET ?? "";
const deployment = (await Bun.file(".local/devnet/deployment.json").json()) as { config: string; genesisHash: string; programId: string };
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
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let token = "";
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
async function confirm(signature: string) {
  for (let i = 0; i < 90; i++) {
    const status = (await client.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
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

const challenge = await api<{ challengeId: string; message: string }>("/v1/auth/challenge", { address: owner, origin: "http://localhost:3001" });
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
client.useLookupTables((await api<{ tables: string[] }>("/v1/lookup-tables")).tables);
const permission = await api<{ active: boolean; delegate: string | null; grant: null | { expiresAt: string } }>(`/v1/trading/permission?owner=${owner}`);
if (!permission.active || !permission.delegate || !permission.grant) throw new Error("Trading permission is inactive");

const marketKey = key(MARKET);
const market = await client.market(marketKey);
const legs = await liveLegs(client.connection, market, client.config, client.program);
const balances = async () => {
  const wallet = await client.wallet(marketKey, admin.publicKey);
  if (!wallet) throw new Error("No admin wallet in this market");
  return (asset: number) => big(wallet.balances[asset]!);
};
const snapshot = async (label: string) => {
  const b = await balances();
  const row: Record<string, string> = {};
  for (let c = 0; c <= market.bases; c++) row[`c${c}`] = `YES ${b(claimAsset(c, 0))} / NO ${b(claimAsset(c, 1))}`;
  log(label, row);
  return b;
};
const merge = async (collaterals: number[], label: string) => {
  const b = await balances();
  const instructions = [];
  for (const c of collaterals) {
    const amount = b(claimAsset(c, 0)) < b(claimAsset(c, 1)) ? b(claimAsset(c, 0)) : b(claimAsset(c, 1));
    if (amount > 0n) instructions.push(client.positionCredit(marketKey, admin.publicKey, c), client.position("merge", marketKey, admin.publicKey, c, amount));
  }
  if (instructions.length) await send(label, envelope(instructions, client.program));
};

await snapshot("before");
// 1. Matching YES/NO pairs of each issuer leg back into pool credit.
await merge(Array.from({ length: market.bases }, (_, i) => i + 1), "merge-legs");
// 2. Sell the one-sided leg remainder (whole steps) into the book.
const step = big(market.terms.step),
  tick = big(market.terms.tick);
for (let c = 1; c <= market.bases; c++)
  for (const branch of [0, 1] as const) {
    const held = (await balances())(claimAsset(c, branch));
    const leg = legs[c]!;
    // Largest whole-step share quantity whose rounded-up reservation the claim covers.
    let quantity = (BigInt(Math.floor((Number(held) * leg.multiplierValue) / Number(leg.scale))) / step) * step;
    while (quantity > 0n && baseRaw(quantity, leg.scale, leg.multiplier, true) > held) quantity -= step;
    while (baseRaw(quantity + step, leg.scale, leg.multiplier, true) <= held) quantity += step;
    if (quantity <= 0n) continue;
    const bids = (await api<{ orders: (OrderWire & { remaining: string; status: string })[] }>(`/orderbook/${MARKET}?limit=2000`)).orders
      .filter((o) => o.status === "open" && o.branch === branch && o.side === 0 && o.maker !== owner && (o.bases & legBit(c)) !== 0)
      .map((o) => BigInt(o.limitPriceRawX18))
      .sort((a, b) => (a > b ? -1 : 1));
    if (!bids.length) throw new Error(`No bids for leg ${c} branch ${branch}`);
    const limit = ((bids[0]! * BigInt(100 - Number(process.env.CLOSE_BOUND_PCT ?? 1))) / 100n / tick) * tick;
    const now = Date.now();
    const order = parseOrder({
      maker: owner,
      recipient: owner,
      delegate: permission.delegate,
      marketId: MARKET,
      salt: orderSalt(BigInt(now), randomBytes(32)),
      quantity: quantity.toString(),
      limitPriceRawX18: limit.toString(),
      expiry: String(Math.min(Math.floor(now / 1000) + 86_400, Number(market.terms.trading_cutoff) - 1, Number(permission.grant.expiresAt) - 1)),
      nonce: String(now),
      maxFeeBps: 100,
      branch,
      side: 1,
      fundingKind: 1,
      tif: 1,
      bases: legBit(c),
    });
    const review = await api<{ orderHash: string; plan: unknown }>("/v1/orders/prepare", { order });
    const plan = parseAtomicPlan(review.plan, order);
    if (review.orderHash !== orderId(order, client.program)) throw new Error("API order identity differs");
    const submitted = await api<{ signature: string }>("/v1/trading/submit", { order });
    await confirm(submitted.signature);
    log("sold", { collateral: c, branch: branch === 0 ? "YES" : "NO", shares: Number(plan.filledQuantity) / 1e6, quoteUsd: Number(plan.executionQuote) / 1e6, signature: submitted.signature });
    await sleep(2_000);
  }
// 3. Matching USDC-YES/USDC-NO pairs back into credit.
await merge([0], "merge-quote");
const after = await snapshot("after");
log("remaining", {
  quoteYes: after(claimAsset(0, 0)),
  quoteNo: after(claimAsset(0, 1)),
  legDust: Array.from({ length: market.bases }, (_, i) => [after(claimAsset(i + 1, 0)), after(claimAsset(i + 1, 1))]),
});
