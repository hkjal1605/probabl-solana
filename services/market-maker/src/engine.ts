import {
  big,
  bn,
  key,
  digest,
  orderId,
  orderSalt,
  boundOrderNonce,
  U64_MAX,
  orderWire,
  fundingAsset,
  walletAddress,
  quote,
  planOrder,
  supportedMint,
  liveLegs,
  baseRaw,
  ASSETS,
  claimAsset,
  underlyingAsset,
  orderCollateral,
  legBit,
  legsOf,
  singleBase,
  type OrderAccount,
  type OrderWire,
  type MarketAccount,
  type LiveLeg,
} from "@conditional-stocks/solana-client";
import { snapshot, liveOrder, type Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { globalAvailable } from "@conditional-stocks/solana-indexer/custody";
import {
  BPS,
  abs,
  max,
  min,
  seedUnits,
  units,
  type MarketPolicy,
  type Settings,
} from "./config.ts";
import { fetchReference } from "./feeds.ts";
import {
  equity,
  needsReplace,
  quotes,
  shareUnits,
  tradableMask,
  type Book,
  type Legs,
  type Quote,
  type Reference,
} from "./strategy.ts";
import type { Executor } from "./execution.ts";
import type { MarketState, State } from "./state.ts";
import type { SolanaClient, PublicKey } from "@conditional-stocks/solana-client";
import { SystemProgram } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const log = (event: string, detail: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ event, ...detail }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
export function owned(s: Snapshot, owner: PublicKey, market?: string) {
  return [...s.orders].filter(
    ([, o]) =>
      o.owner.equals(owner) && o.status === 1 && (!market || o.market.toBase58() === market),
  );
}
export function inventory(s: Snapshot, owner: PublicKey, market: string) {
  const balances = s.wallets
    .get(walletAddress(key(market), owner, s.program).toBase58())
    ?.balances.map(big) ?? Array<bigint>(ASSETS).fill(0n);
  if (balances.length !== ASSETS) throw new Error("Unexpected market wallet layout");
  for (const [, order] of owned(s, owner, market))
    balances[fundingAsset(orderWire(order))]! += big(order.reserved);
  return balances;
}
/** Per-leg seed, raw issuer units (0 for unseeded legs). */
export function seeds(p: MarketPolicy, m: MarketAccount): bigint[] {
  return p.baseInventories.map((value, i) => seedUnits(value, m.decimals[i + 1]!));
}
/** Target branch position in share units: explicit, or the seeds at live multipliers. */
export function targetShares(p: MarketPolicy, m: MarketAccount, legs: Legs): bigint {
  if (p.targetShares !== undefined) return units(p.targetShares, m.terms.share_decimals);
  return seeds(p, m).reduce((sum, raw, i) => {
    const leg = legs[i + 1];
    if (!leg) throw new Error("Missing live leg state");
    return sum + shareUnits(raw, leg.scale, leg.multiplier);
  }, 0n);
}
/** Raw funding an order reserves: quote notional for bids, rounded-up issuer claims for asks. */
export function reservation(
  q: { side: number; bases: number; price: bigint; quantity: bigint },
  legs: Legs,
) {
  if (q.side === 0) return quote(q.quantity, q.price, true);
  const leg = legs[singleBase(q.bases) ?? 0];
  if (!leg) throw new Error("Missing live leg state");
  return baseRaw(q.quantity, leg.scale, leg.multiplier, true);
}
/** One book ladder: all bids of a branch, or one issuer's asks of a branch. */
const ladders = (branch: number) => [
  { branch, side: 0, bases: 0 },
  ...[1, 2, 3].map((c) => ({ branch, side: 1, bases: legBit(c) })),
];
const inLadder = (
  l: { branch: number; side: number; bases: number },
  o: { branch: number; side: number; bases: number },
) => o.branch === l.branch && o.side === l.side && (l.side === 0 || o.bases === l.bases);
export function quoteChange(
  current: [string, OrderAccount][],
  desired: Quote[],
  now: bigint,
  s: Settings,
  live?: { makerBps: number; minimumNonce: bigint; legs?: Legs },
): { cancel?: string; quote?: Quote } | undefined {
  for (const branch of [0, 1] as const)
    for (const ladder of ladders(branch)) {
      const side = ladder.side;
      const ranked = current
          .filter(([, o]) => inLadder(ladder, o.terms))
          .sort(([, a], [, b]) => {
            const ap = big(a.terms.price),
              bp = big(b.terms.price);
            return ap === bp ? 0 : (ap > bp ? -1 : 1) * (side === 0 ? 1 : -1);
          }),
        targets = desired.filter((q) => inLadder(ladder, q)).sort((a, b) => a.level - b.level);
      for (let level = 0; level < ranked.length; level++) {
        const [id, o] = ranked[level]!,
          target = targets[level];
        if (
          !target ||
          o.terms.funding !== 1 ||
          o.terms.tif !== 0 ||
          !o.terms.recipient.equals(o.owner)
        )
          return { cancel: id };
        // An ask whose reservation no longer covers the live conversion (the
        // multiplier fell within its band) cannot deliver; re-reserve it.
        const leg = side === 1 ? live?.legs?.[singleBase(o.terms.bases) ?? 0] : undefined;
        if (
          (live &&
            (o.terms.max_fee_bps !== live.makerBps || big(o.terms.nonce) < live.minimumNonce)) ||
          o.terms.bases !== target.bases ||
          (leg && baseRaw(big(o.remaining), leg.scale, leg.multiplier) > big(o.reserved)) ||
          big(o.remaining) > target.quantity ||
          needsReplace(
            { price: big(o.terms.price), remaining: big(o.remaining), expiry: big(o.terms.expiry) },
            target,
            now,
            s,
          )
        )
          return { cancel: id, quote: target };
      }
      if (ranked.length < targets.length) return { quote: targets[ranked.length]! };
    }
  return undefined;
}
export function passiveOrder(
  owner: PublicKey,
  id: string,
  market: MarketAccount,
  s: Snapshot,
  q: Quote,
  ttl: number,
  now: bigint,
): OrderWire {
  const nonce = s.traders.get(owner.toBase58())?.minimum_nonce ?? bn(0);
  return {
    maker: owner.toBase58(),
    recipient: owner.toBase58(),
    marketId: id,
    salt: orderSalt(big(nonce), digest(crypto.randomUUID())),
    quantity: String(q.quantity),
    limitPriceRawX18: String(q.price),
    expiry: String(min(now + BigInt(ttl), big(market.terms.trading_cutoff) - 1n)),
    nonce: nonce.toString(),
    maxFeeBps: s.config.maker_bps,
    branch: q.branch,
    side: q.side,
    fundingKind: 1,
    tif: 0,
    bases: q.bases,
  };
}
/** Best foreign bid/ask per leg and branch. A bid counts on every leg it accepts. */
export function foreignBook(s: Snapshot, owner: PublicKey, market: string): Book {
  const best: Book = [{}, {}];
  for (const [, o] of s.orders)
    if (o.market.toBase58() === market && !o.owner.equals(owner) && liveOrder(o, s)) {
      const tops = best[o.terms.branch as 0 | 1],
        price = big(o.terms.price);
      if (o.terms.side === 0)
        for (const c of legsOf(o.terms.bases)) {
          const top = (tops[c] ??= {});
          top.bid = top.bid === undefined ? price : max(top.bid, price);
        }
      else {
        const c = singleBase(o.terms.bases);
        if (c === null) continue;
        const top = (tops[c] ??= {});
        top.ask = top.ask === undefined ? price : min(top.ask, price);
      }
    }
  return best;
}
/** Persist the last safe observation; spot is per share unit. */
function checkpoint(record: MarketState, r: Reference) {
  record.spot = String(r.spot);
  record.probability = String(r.probability);
  record.observedAt = r.observedAt;
  record.priceUnit = "share";
}
const halts = (legs: Record<number, LiveLeg>) =>
  Object.fromEntries(Object.entries(legs).map(([c, l]) => [c, l.halt]));
export class Engine {
  stopped = false;
  constructor(
    readonly client: SolanaClient,
    readonly owner: PublicKey,
    readonly settings: Settings,
    readonly origin: string,
    readonly state: State,
    readonly save: () => void,
    readonly executor?: Executor,
    readonly readReference = fetchReference,
  ) {}
  async view() {
    const s = await snapshot(this.client, "confirmed");
    if (s.slot < this.state.lastSlot)
      throw new Error("RPC snapshot is behind the last submitted transaction");
    return s;
  }
  async cancelMarket(id?: string, liveOnly = false) {
    if (!this.executor) return;
    await this.executor.reconcilePending();
    const s = await this.view();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const groups = new Map<string, PublicKey[]>();
    for (const [orderId, indexed] of owned(s, this.owner, id)) {
      if (liveOnly && big(indexed.terms.expiry) <= now) continue;
      const market = indexed.market.toBase58();
      const batch = groups.get(market) ?? [];
      batch.push(key(orderId));
      groups.set(market, batch);
    }
    for (const [market, orders] of groups) {
      const marketAccount = s.markets.get(market);
      if (!marketAccount) throw new Error("Missing market for cancellation");
      this.client.rememberMarket(key(market), marketAccount);
      for (let i = 0; i < orders.length; i += 8) {
        const batch = orders.slice(i, i + 8);
        const refunds = [
          ...new Set(
            batch.flatMap((address) => {
              const order = s.orders.get(address.toBase58())!;
              const { funding, side, bases } = order.terms;
              return funding === 0 ? [underlyingAsset(orderCollateral({ side, bases }))] : [];
            }),
          ),
        ];
        await this.executor.send(
          [this.client.orderMaintenance("cancel_orders", key(market), this.owner, batch, refunds)],
          true,
        );
      }
    }
  }
  /** Explicit offline maintenance, not a quote-loop side effect. Advancing the
   * owner-wide nonce can invalidate other markets, so require no open orders. */
  async reclaimRent() {
    if (!this.executor) throw new Error("Rent recovery requires explicit execution");
    await this.executor.reconcilePending();
    let s = await this.view();
    if (owned(s, this.owner).length)
      throw new Error("Cancel all open orders before recovering rent");
    let minimum = big(s.traders.get(this.owner.toBase58())?.minimum_nonce ?? bn(0));
    const currentMinimum = minimum;
    for (const [, order] of s.orders) {
      if (!order.owner.equals(this.owner)) continue;
      const bound = boundOrderNonce(Uint8Array.from(order.terms.salt));
      if (bound !== null && bound >= minimum) {
        if (bound === U64_MAX)
          throw new Error("Maximum nonce cannot be advanced; retire after market closure");
        minimum = bound + 1n;
      }
    }
    if (minimum > currentMinimum) {
      await this.executor.send([this.client.invalidateNonce(this.owner, minimum)], true);
      s = await this.view();
    }
    const groups = new Map<string, PublicKey[]>();
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const [id, order] of s.orders) {
      if (!order.owner.equals(this.owner)) continue;
      const market = s.markets.get(order.market.toBase58());
      if (!market) throw new Error("Missing market for rent recovery");
      const bound = boundOrderNonce(Uint8Array.from(order.terms.salt));
      const closed = [3, 4, 6, 7].includes(market.state) || big(market.terms.trading_cutoff) <= now;
      if (!closed && (bound === null || bound !== big(order.terms.nonce) || bound >= minimum))
        continue;
      const batch = groups.get(order.market.toBase58()) ?? [];
      batch.push(key(id));
      groups.set(order.market.toBase58(), batch);
    }
    for (const [market, orders] of groups) {
      for (let i = 0; i < orders.length; i += 8)
        await this.executor.send(
          [
            this.client.orderMaintenance(
              "retire_orders",
              key(market),
              this.owner,
              orders.slice(i, i + 8),
            ),
          ],
          true,
        );
    }
  }
  async validateMarket(s: Snapshot, p: MarketPolicy) {
    const market = s.markets.get(p.market),
      now = BigInt(Math.floor(Date.now() / 1000)),
      quoteReady = (1 << underlyingAsset(0)) | (1 << claimAsset(0, 0)) | (1 << claimAsset(0, 1));
    if (
      !market ||
      s.config.paused ||
      market.state !== 2 ||
      (market.vaults_initialized & quoteReady) !== quoteReady ||
      big(market.terms.trading_open) > now ||
      big(market.terms.trading_cutoff) <= now + BigInt(this.settings.cutoffBufferSeconds)
    )
      throw new Error("Market paused, closed, or near cutoff");
    // Issuer legs are an exact, reviewed identity. A newly listed leg needs review.
    if (
      market.bases !== p.baseMints.length ||
      p.baseMints.some((mint, i) => market.mints[underlyingAsset(i + 1)]!.toBase58() !== mint) ||
      market.mints[0]!.toBase58() !== p.quoteMint ||
      !market.mints[0]!.equals(s.config.quote_mint)
    )
      throw new Error("Market allocation identity changed");
    const metadata = await supportedMint(this.client.connection, key(p.quoteMint));
    if (metadata.decimals !== market.decimals[0]) throw new Error("Token decimals changed");
    return this.client.rememberMarket(key(p.market), market);
  }
  /** Live issuer state of every leg. Issuer pauses, frozen vaults, delistings,
   * corporate actions and unreadable mints halt a leg rather than the market. */
  async legs(market: MarketAccount): Promise<Record<number, LiveLeg>> {
    const legs = await liveLegs(
      this.client.connection,
      market,
      this.client.config,
      this.client.program,
    );
    for (let c = 1; c <= market.bases; c++)
      if (!legs[c] || legs[c]!.decimals !== market.decimals[c])
        throw new Error("Issuer leg state is incomplete");
    return legs;
  }
  plan(s: Snapshot, m: MarketAccount, p: MarketPolicy, r: Reference, legs: Legs) {
    const record = this.state.markets[p.market] ?? (this.state.markets[p.market] = {});
    const now = Date.now();
    if (record.halted) throw new Error("Persistent market drawdown halt");
    if (
      now - r.observedAt > this.settings.maxFeedAgeMs ||
      r.observedAt > now + 5000 ||
      (record.observedAt !== undefined && r.observedAt < record.observedAt)
    )
      throw new Error("Reference is stale or moved backwards");
    // Checkpoints from before multi-issuer markets priced raw base units; their
    // spot is not comparable, but their movement (bps), peak and latches are.
    if (record.spot && record.priceUnit === "share") {
      const move = (abs(r.spot - BigInt(record.spot)) * BPS) / BigInt(record.spot),
        probMove = abs(r.probability - BigInt(record.probability!));
      if (
        move >= BigInt(this.settings.jumpBps) ||
        probMove >= BigInt(this.settings.probabilityJumpX6)
      )
        record.cooldownUntil = now + this.settings.cooldownMs;
      // Multiple cancel/replaces are one observation, not four new volatility samples.
      if (move > 0n || probMove > 0n || now - (record.movementAt ?? 0) >= this.settings.pollMs) {
        record.movement = String((BigInt(record.movement ?? "0") * 3n + move) / 4n);
        record.movementAt = now;
      }
    }
    checkpoint(record, r);
    const target = targetShares(p, m, legs),
      cash = units(p.quoteInventory, m.decimals[0]!);
    let balances: bigint[];
    if (this.executor) balances = inventory(s, this.owner, p.market);
    else {
      balances = Array<bigint>(ASSETS).fill(0n);
      balances[claimAsset(0, 0)] = balances[claimAsset(0, 1)] = cash;
      for (const [i, raw] of seeds(p, m).entries())
        balances[claimAsset(i + 1, 0)] = balances[claimAsset(i + 1, 1)] = raw;
    }
    const mark = equity(balances, r, p.gapBps, m.bases, legs),
      peak = max(mark, BigInt(record.peak ?? "0"));
    record.peak = String(peak);
    if (peak > 0n && (peak - mark) * BPS >= peak * BigInt(this.settings.maxDrawdownBps))
      record.halted = true;
    this.save();
    if (record.halted || now < (record.cooldownUntil ?? 0)) throw new Error("Risk circuit breaker");
    return quotes({
      market: m,
      reference: r,
      gapBps: p.gapBps,
      balances,
      legs,
      targetShares: target,
      orderQuote: units(p.orderQuote, m.decimals[0]!),
      makerBps: s.config.maker_bps,
      movementBps: BigInt(record.movement ?? "0"),
      settings: this.settings,
      best: foreignBook(s, this.owner, p.market),
    });
  }
  async cycle() {
    await this.executor?.reconcilePending();
    const initial = await this.view();
    const configured = new Set(this.settings.markets.map((p) => p.market));
    for (const id of new Set(owned(initial, this.owner).map(([, o]) => o.market.toBase58())))
      if (!configured.has(id)) await this.cancelMarket(id);
    log("discovery", {
      openMarkets: [...initial.markets]
        .filter(([, m]) => m.state === 2)
        .map(([id, m]) => ({
          id,
          baseMints: Array.from({ length: m.bases }, (_, i) =>
            String(m.mints[underlyingAsset(i + 1)]),
          ),
          quoteMint: String(m.mints[0]),
          configured: configured.has(id),
        })),
    });
    for (const p of this.settings.markets) {
      if (this.stopped) break;
      let stage = "snapshot";
      try {
        // Serial, atomic cancel/replace. Re-read balances, book sequence, issuer
        // state and feeds for each action. One bid and one ask ladder per leg per branch.
        const steps = 2 * (1 + p.baseMints.length) * this.settings.quoteLevels;
        for (let step = 0; step < steps && !this.stopped; step++) {
          stage = "market-and-token-validation";
          const s = await this.view(),
            m = await this.validateMarket(s, p);
          stage = "issuer-legs";
          const legs = await this.legs(m);
          stage = "reference-feeds";
          const r = await this.readReference(
            this.origin,
            this.client.deployment.genesisHash,
            m,
            p,
            this.settings,
            legs,
          );
          stage = "inventory-and-risk";
          const desired = this.plan(s, m, p, r, legs);
          if (step === 0)
            log("risk", {
              market: p.market,
              peakQuoteRaw: this.state.markets[p.market]?.peak,
              movementBps: this.state.markets[p.market]?.movement ?? "0",
              tradableLegs: tradableMask(m.bases, legs),
              halts: halts(legs),
            });
          if (!this.executor) {
            log("dry-run", {
              market: p.market,
              assumedSeedInventory: true,
              spot: r.spot,
              legSpots: r.legs,
              probability: r.probability,
              quotes: desired,
            });
            break;
          }
          const action = quoteChange(
            owned(s, this.owner, p.market),
            desired,
            BigInt(Math.floor(Date.now() / 1000)),
            this.settings,
            {
              makerBps: s.config.maker_bps,
              minimumNonce: big(s.traders.get(this.owner.toBase58())?.minimum_nonce ?? bn(0)),
              legs,
            },
          );
          if (!action) break;
          const instructions = [];
          if (action.cancel)
            instructions.push(await this.client.cancel(key(action.cancel), this.owner));
          if (action.quote) {
            const q = action.quote,
              o = passiveOrder(
                this.owner,
                p.market,
                m,
                s,
                q,
                this.settings.ttlSeconds,
                BigInt(Math.floor(Date.now() / 1000)),
              );
            const wallet = s.wallets.get(
              walletAddress(key(p.market), this.owner, this.client.program).toBase58(),
            );
            const cancelled = action.cancel ? s.orders.get(action.cancel) : undefined;
            const released =
              cancelled && fundingAsset(orderWire(cancelled)) === fundingAsset(o)
                ? big(cancelled.reserved)
                : 0n;
            const available = (wallet ? big(wallet.balances[fundingAsset(o)]!) : 0n) + released;
            if (available < reservation(q, legs))
              throw new Error("Seeded claim inventory is insufficient");
            const plan = planOrder({
              order: o,
              candidates: [],
              now: BigInt(Math.floor(Date.now() / 1000)),
              step: big(m.terms.step),
              nextSequence: big(m.sequence[q.branch]!),
              makerFeeBps: s.config.maker_bps,
              takerFeeBps: s.config.taker_bps,
              program: this.client.program,
              legs,
            });
            instructions.push(this.client.placement(o, plan, m));
            if (Date.now() - r.observedAt > this.settings.maxFeedAgeMs)
              throw new Error("Reference expired before signing");
            log("quote", {
              market: p.market,
              order: orderId(o, this.client.program),
              branch: q.branch,
              side: q.side,
              bases: q.bases,
              level: q.level,
              price: q.price,
              quantity: q.quantity,
            });
          }
          stage = "execution";
          await this.executor.send(
            instructions,
            !action.quote,
            () =>
              !action.quote ||
              (!this.stopped && Date.now() - r.observedAt <= this.settings.maxFeedAgeMs),
          );
        }
      } catch {
        log("market-paused", {
          market: p.market,
          stage,
          reason:
            "Reference, market, inventory, or execution safety check failed; cancelling quotes",
        });
        await this.cancelMarket(p.market);
      }
    }
  }
  /** One-time, resumable ladder placement using the last observed safe reference.
   * It does not poll, reprice, or cancel orders when that reference later ages. */
  async staticCycle() {
    if (!this.executor) throw new Error("Static placement requires explicit live execution");
    await this.executor.reconcilePending();
    for (const p of this.settings.markets) {
      if (this.stopped) break;
      let stage = "snapshot";
      try {
        const before = await this.view(),
          market = await this.validateMarket(before, p),
          record = this.state.markets[p.market] ?? (this.state.markets[p.market] = {});
        if (!record.fundComplete) throw new Error("Market lacks funded inventory");
        stage = "issuer-legs";
        let legs = await this.legs(market);
        const seeded = seeds(p, market);
        const ladder = (branch: number, side: number, bases: number) =>
          side === 0 ? `${branch}:bid` : `${branch}:ask:${bases}`;
        // Both consolidated bids, plus asks for every seeded tradable leg.
        const required = (current: Legs) => {
          const mask = tradableMask(market.bases, current);
          if (!mask) throw new Error("No tradable issuer leg");
          return [0, 1].flatMap((branch) => [
            ladder(branch, 0, mask),
            ...legsOf(mask)
              .filter((c) => seeded[c - 1]! > 0n)
              .map((c) => ladder(branch, 1, legBit(c))),
          ]);
        };
        const count = (orders: [string, OrderAccount][], id: string) =>
          orders.filter(([, o]) => ladder(o.terms.branch, o.terms.side, o.terms.bases) === id)
            .length;
        const beforeOrders = owned(before, this.owner, p.market).filter(
            ([, order]) => big(order.terms.expiry) > BigInt(Math.floor(Date.now() / 1000)),
          ),
          beforeMinimumNonce = big(
            before.traders.get(this.owner.toBase58())?.minimum_nonce ?? bn(0),
          ),
          compatibleBeforeOrders = beforeOrders.filter(
            ([, order]) =>
              order.terms.funding === 1 &&
              order.terms.tif === 0 &&
              order.terms.recipient.equals(this.owner) &&
              order.terms.max_fee_bps === before.config.maker_bps &&
              big(order.terms.nonce) >= beforeMinimumNonce &&
              big(order.remaining) > 0n,
          );
        if (compatibleBeforeOrders.length !== beforeOrders.length)
          throw new Error("Static seed found an incompatible existing order");
        if (
          required(legs).every(
            (id) => count(compatibleBeforeOrders, id) >= this.settings.quoteLevels,
          )
        ) {
          log("static-market-complete", { market: p.market, alreadyPopulated: true });
          continue;
        }
        stage = "reference-feeds";
        const reference = await this.readReference(
          this.origin,
          this.client.deployment.genesisHash,
          market,
          p,
          this.settings,
          legs,
        );
        checkpoint(record, reference);
        this.save();
        const held = inventory(before, this.owner, p.market);
        for (let c = 1; c <= market.bases; c++) {
          const needed =
            seeded[c - 1]! - min(held[claimAsset(c, 0)]!, held[claimAsset(c, 1)]!, seeded[c - 1]!);
          if (needed <= 0n) continue;
          if (!legs[c]?.tradable) {
            log("static-leg-skipped", { market: p.market, collateral: c, halt: legs[c]?.halt });
            continue;
          }
          stage = "base-top-up";
          await this.seedClaims(await this.view(), p.market, market, c, needed);
        }
        const steps = 2 * (1 + market.bases) * this.settings.quoteLevels;
        for (let step = 0; step < steps && !this.stopped; step++) {
          const s = await this.view(),
            m = await this.validateMarket(s, p);
          legs = await this.legs(m);
          const existing = owned(s, this.owner, p.market).filter(
            ([, o]) => big(o.terms.expiry) > BigInt(Math.floor(Date.now() / 1000)),
          );
          const desired = quotes({
            market: m,
            reference,
            gapBps: p.gapBps,
            balances: inventory(s, this.owner, p.market),
            legs,
            targetShares: targetShares(p, m, legs),
            orderQuote: units(p.orderQuote, m.decimals[0]!),
            makerBps: s.config.maker_bps,
            movementBps: 0n,
            settings: this.settings,
            best: [{}, {}],
          });
          const ids = required(legs);
          const planned = (id: string) =>
            desired.filter((q) => ladder(q.branch, q.side, q.bases) === id).length;
          if (ids.some((id) => planned(id) !== this.settings.quoteLevels))
            throw new Error("Inventory cannot back every requested static level");
          const represented = (q: Quote) =>
            existing.some(
              ([, o]) =>
                o.terms.branch === q.branch &&
                o.terms.side === q.side &&
                o.terms.bases === q.bases &&
                big(o.terms.price) === q.price &&
                o.terms.funding === 1 &&
                o.terms.tif === 0 &&
                o.terms.recipient.equals(this.owner),
            );
          const minimumNonce = big(s.traders.get(this.owner.toBase58())?.minimum_nonce ?? bn(0)),
            missing = new Map(
              desired
                .filter(
                  (q) =>
                    count(existing, ladder(q.branch, q.side, q.bases)) <
                      this.settings.quoteLevels && !represented(q),
                )
                .map((q) => [`${q.branch}:${q.side}:${q.bases}:${q.price}`, q]),
            );
          for (const [, held] of existing) {
            const terms = held.terms,
              id = `${terms.branch}:${terms.side}:${terms.bases}:${big(terms.price)}`,
              target = missing.get(id);
            if (
              terms.funding !== 1 ||
              terms.tif !== 0 ||
              !terms.recipient.equals(this.owner) ||
              terms.max_fee_bps !== s.config.maker_bps ||
              big(terms.nonce) < minimumNonce ||
              big(held.remaining) <= 0n
            )
              throw new Error("Static seed found an incompatible existing order");
            if (target) missing.delete(id);
          }
          const q = missing.values().next().value as Quote | undefined;
          if (!q) {
            if (ids.some((id) => count(existing, id) < this.settings.quoteLevels))
              throw new Error("Static ladder could not fill every requested side");
            break;
          }
          const order = passiveOrder(
              this.owner,
              p.market,
              m,
              s,
              q,
              this.settings.ttlSeconds,
              BigInt(Math.floor(Date.now() / 1000)),
            ),
            wallet = s.wallets.get(
              walletAddress(key(p.market), this.owner, this.client.program).toBase58(),
            ),
            available = wallet ? big(wallet.balances[fundingAsset(order)]!) : 0n;
          if (available < reservation(q, legs)) throw new Error("Static order is not fully backed");
          const plan = planOrder({
            order,
            candidates: [],
            now: BigInt(Math.floor(Date.now() / 1000)),
            step: big(m.terms.step),
            nextSequence: big(m.sequence[q.branch]!),
            makerFeeBps: s.config.maker_bps,
            takerFeeBps: s.config.taker_bps,
            program: this.client.program,
            legs,
          });
          stage = "execution";
          log("static-quote", {
            market: p.market,
            branch: q.branch,
            side: q.side,
            bases: q.bases,
            level: q.level,
            price: q.price,
            quantity: q.quantity,
          });
          await this.executor.send(
            [this.client.placement(order, plan, m)],
            false,
            () => !this.stopped && Date.now() - reference.observedAt <= this.settings.maxFeedAgeMs,
          );
        }
        log("static-market-complete", { market: p.market });
      } catch (error) {
        log("static-market-skipped", {
          market: p.market,
          stage,
          reason: error instanceof Error ? error.message : "Unknown static placement failure",
        });
      }
    }
  }

  /** Allocate the requested amount of one collateral (0 = quote, 1.. = issuer leg)
   * into THIS market. Reuse unreserved global credit first; never count a shared
   * deposit as inventory in every market. */
  private async seedClaims(
    s: Snapshot,
    id: string,
    market: MarketAccount,
    collateral: number,
    amount: bigint,
  ) {
    if (!this.executor) throw new Error("Claim seeding requires explicit execution");
    this.client.rememberMarket(key(id), market);
    const mint = market.mints[underlyingAsset(collateral)]!;
    const available = globalAvailable(s, String(this.owner), String(mint));
    const deficit = amount > available ? amount - available : 0n;
    if (deficit && mint.equals(NATIVE_MINT)) {
      const source = getAssociatedTokenAddressSync(NATIVE_MINT, this.owner);
      const account = await this.client.connection.getAccountInfo(source, "confirmed");
      const balance = account
        ? BigInt(
            (await this.client.connection.getTokenAccountBalance(source, "confirmed")).value.amount,
          )
        : 0n;
      if (balance < deficit)
        await this.executor.send([
          createAssociatedTokenAccountIdempotentInstruction(
            this.owner,
            source,
            this.owner,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID,
          ),
          SystemProgram.transfer({
            fromPubkey: this.owner,
            toPubkey: source,
            lamports: deficit - balance,
          }),
          createSyncNativeInstruction(source),
        ]);
    }
    const instructions = [];
    if (!s.wallets.has(String(walletAddress(key(id), this.owner, this.client.program))))
      instructions.push(this.client.initializeWallet(key(id), this.owner));
    if (deficit) {
      // Fee-aware Token-2022 deposit into the protocol-wide pool of this mint.
      const deposit = await this.client.depositForCredit(
        key(id),
        this.owner,
        mint,
        underlyingAsset(collateral),
        deficit,
      );
      if (deposit.fee * BPS > deposit.gross * BigInt(this.settings.maxTransferFeeBps))
        throw new Error("Issuer transfer fee exceeds funding policy");
      instructions.push(deposit.instruction);
    }
    instructions.push(
      this.client.positionCredit(key(id), this.owner, collateral),
      this.client.position("split", key(id), this.owner, collateral, amount),
    );
    await this.executor.send(instructions, false, () => !this.stopped);
  }

  async fund() {
    if (!this.executor) throw new Error("Funding requires explicit live execution");
    await this.executor.reconcilePending();
    for (const p of this.settings.markets) {
      if (this.stopped) throw new Error("Funding interrupted");
      const s = await this.view(),
        m = await this.validateMarket(s, p),
        record = this.state.markets[p.market] ?? (this.state.markets[p.market] = {});
      if (record.fundComplete) continue;
      if (record.fundStarted)
        throw new Error(
          "Funding already attempted; inspect the journal and custody before any manual recovery",
        );
      if (
        inventory(s, this.owner, p.market).some((v) => v !== 0n) ||
        owned(s, this.owner, p.market).length
      )
        throw new Error("Funding requires an empty dedicated market wallet");
      const legs = await this.legs(m);
      const reference = await this.readReference(
        this.origin,
        this.client.deployment.genesisHash,
        m,
        p,
        this.settings,
        legs,
      );
      checkpoint(record, reference);
      record.fundStarted = true;
      this.save(); // Never automatically top up losses, including after restart.
      const amounts = [units(p.quoteInventory, m.decimals[0]!), ...seeds(p, m)];
      for (const [collateral, amount] of amounts.entries()) {
        if (amount === 0n) continue;
        // A paused, frozen, delisted or corporate-action leg cannot be split; the
        // static top-up can seed it after the issuer resumes.
        if (collateral > 0 && !legs[collateral]?.tradable) {
          log("fund-leg-skipped", { market: p.market, collateral, halt: legs[collateral]?.halt });
          continue;
        }
        await this.seedClaims(await this.view(), p.market, m, collateral, amount);
      }
      record.fundComplete = true;
      this.save();
      log("funded", { market: p.market });
    }
  }
}
