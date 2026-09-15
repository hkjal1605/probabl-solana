import {
  big,
  bn,
  key,
  hex,
  digest,
  orderId,
  orderWire,
  fundingAsset,
  walletAddress,
  quote,
  planOrder,
  supportedMint,
  type OrderAccount,
  type OrderWire,
  type MarketAccount,
} from "@conditional-stocks/solana-client";
import { snapshot, liveOrder, type Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { BPS, abs, max, min, units, type MarketPolicy, type Settings } from "./config.ts";
import { fetchReference } from "./feeds.ts";
import { equity, needsReplace, quotes, type Quote, type Reference } from "./strategy.ts";
import type { Executor } from "./execution.ts";
import type { State } from "./state.ts";
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
    ?.balances.map(big) ?? [0n, 0n, 0n, 0n, 0n, 0n];
  for (const [, order] of owned(s, owner, market))
    balances[fundingAsset(orderWire(order))]! += big(order.reserved);
  return balances;
}
export function quoteChange(
  current: [string, OrderAccount][],
  desired: Quote[],
  now: bigint,
  s: Settings,
  live?: { makerBps: number; minimumNonce: bigint },
): { cancel?: string; quote?: Quote } | undefined {
  for (const branch of [0, 1] as const)
    for (const side of [0, 1] as const) {
      const ranked = current
          .filter(([, o]) => o.terms.branch === branch && o.terms.side === side)
          .sort(([, a], [, b]) => {
            const ap = big(a.terms.price),
              bp = big(b.terms.price);
            return ap === bp ? 0 : (ap > bp ? -1 : 1) * (side === 0 ? 1 : -1);
          }),
        targets = desired
          .filter((q) => q.branch === branch && q.side === side)
          .sort((a, b) => a.level - b.level);
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
        if (
          (live &&
            (o.terms.max_fee_bps !== live.makerBps || big(o.terms.nonce) < live.minimumNonce)) ||
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
    salt: hex(digest(crypto.randomUUID())),
    quantity: String(q.quantity),
    limitPriceRawX18: String(q.price),
    expiry: String(min(now + BigInt(ttl), big(market.terms.trading_cutoff) - 1n)),
    nonce: nonce.toString(),
    maxFeeBps: s.config.maker_bps,
    branch: q.branch,
    side: q.side,
    fundingKind: 1,
    tif: 0,
  };
}
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
  async cancelMarket(id?: string) {
    if (!this.executor) return;
    await this.executor.reconcilePending();
    const s = await this.view();
    for (const [orderId] of owned(s, this.owner, id)) {
      const current = await this.client.order(key(orderId));
      if (current.status !== 1) continue;
      if (!current.owner.equals(this.owner)) throw new Error("Foreign cancellation");
      await this.executor.send([await this.client.cancel(key(orderId), this.owner)], true);
    }
  }
  async validateMarket(s: Snapshot, p: MarketPolicy) {
    const market = s.markets.get(p.market),
      now = BigInt(Math.floor(Date.now() / 1000));
    if (
      !market ||
      s.config.paused ||
      market.state !== 2 ||
      market.vaults_initialized !== 63 ||
      big(market.terms.trading_open) > now ||
      big(market.terms.trading_cutoff) <= now + BigInt(this.settings.cutoffBufferSeconds)
    )
      throw new Error("Market paused, closed, or near cutoff");
    if (
      market.mints[0]!.toBase58() !== p.baseMint ||
      market.mints[1]!.toBase58() !== p.quoteMint ||
      !market.mints[1]!.equals(s.config.quote_mint)
    )
      throw new Error("Market allocation identity changed");
    const metadata = await Promise.all([
      supportedMint(this.client.connection, key(p.baseMint)),
      supportedMint(this.client.connection, key(p.quoteMint)),
    ]);
    if (metadata.some((m, i) => m.decimals !== market.decimals[i]))
      throw new Error("Token decimals changed");
    return market;
  }
  plan(s: Snapshot, m: MarketAccount, p: MarketPolicy, r: Reference) {
    const record = this.state.markets[p.market] ?? (this.state.markets[p.market] = {});
    const now = Date.now();
    if (record.halted) throw new Error("Persistent market drawdown halt");
    if (
      now - r.observedAt > this.settings.maxFeedAgeMs ||
      r.observedAt > now + 5000 ||
      (record.observedAt !== undefined && r.observedAt < record.observedAt)
    )
      throw new Error("Reference is stale or moved backwards");
    if (record.spot) {
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
    record.spot = String(r.spot);
    record.probability = String(r.probability);
    record.observedAt = r.observedAt;
    const target = units(p.baseInventory, m.decimals[0]!),
      cash = units(p.quoteInventory, m.decimals[1]!);
    const balances = this.executor
      ? inventory(s, this.owner, p.market)
      : [0n, 0n, target, target, cash, cash];
    const mark = equity(balances, r, p.gapBps),
      peak = max(mark, BigInt(record.peak ?? "0"));
    record.peak = String(peak);
    if (peak > 0n && (peak - mark) * BPS >= peak * BigInt(this.settings.maxDrawdownBps))
      record.halted = true;
    this.save();
    if (record.halted || now < (record.cooldownUntil ?? 0)) throw new Error("Risk circuit breaker");
    const best: [{ bid?: bigint; ask?: bigint }, { bid?: bigint; ask?: bigint }] = [{}, {}];
    for (const [, o] of s.orders)
      if (o.market.toBase58() === p.market && !o.owner.equals(this.owner) && liveOrder(o, s)) {
        const b = best[o.terms.branch as 0 | 1],
          price = big(o.terms.price);
        if (o.terms.side === 0) b.bid = b.bid === undefined ? price : max(b.bid, price);
        else b.ask = b.ask === undefined ? price : min(b.ask, price);
      }
    return quotes({
      market: m,
      reference: r,
      gapBps: p.gapBps,
      balances,
      targetBase: target,
      orderQuote: units(p.orderQuote, m.decimals[1]!),
      makerBps: s.config.maker_bps,
      movementBps: BigInt(record.movement ?? "0"),
      settings: this.settings,
      best,
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
          baseMint: String(m.mints[0]),
          quoteMint: String(m.mints[1]),
          configured: configured.has(id),
        })),
    });
    for (const p of this.settings.markets) {
      if (this.stopped) break;
      let stage = "snapshot";
      try {
        // Serial, atomic cancel/replace. Re-read balances, book sequence and feeds for each action.
        for (let step = 0; step < 4 * this.settings.quoteLevels && !this.stopped; step++) {
          stage = "market-and-token-validation";
          const s = await this.view(),
            m = await this.validateMarket(s, p);
          stage = "reference-feeds";
          const r = await this.readReference(
            this.origin,
            this.client.deployment.genesisHash,
            m,
            p,
            this.settings,
          );
          stage = "inventory-and-risk";
          const desired = this.plan(s, m, p, r);
          if (step === 0)
            log("risk", {
              market: p.market,
              peakQuoteRaw: this.state.markets[p.market]?.peak,
              movementBps: this.state.markets[p.market]?.movement ?? "0",
            });
          if (!this.executor) {
            log("dry-run", {
              market: p.market,
              assumedSeedInventory: true,
              spot: r.spot,
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
            const released = action.cancel ? big(s.orders.get(action.cancel)!.reserved) : 0n;
            const available = (wallet ? big(wallet.balances[fundingAsset(o)]!) : 0n) + released;
            if (available < (q.side === 0 ? quote(q.quantity, q.price, true) : q.quantity))
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
            });
            instructions.push(this.client.placement(o, plan));
            if (Date.now() - r.observedAt > this.settings.maxFeedAgeMs)
              throw new Error("Reference expired before signing");
            log("quote", {
              market: p.market,
              order: orderId(o, this.client.program),
              branch: q.branch,
              side: q.side,
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
      let stage = "snapshot";
      try {
        if (p.baseMint !== NATIVE_MINT.toBase58()) {
          const before = await this.view(),
            market = await this.validateMarket(before, p),
            held = inventory(before, this.owner, p.market),
            target = units(p.baseInventory, market.decimals[0]!),
            needed = target - min(held[2]!, held[3]!);
          if (needed > 0n) {
            const deposit = await this.client.depositForCredit(
              key(p.market),
              this.owner,
              market.mints[0]!,
              0,
              needed,
            );
            if (deposit.fee * BPS > deposit.gross * BigInt(this.settings.maxTransferFeeBps))
              throw new Error("Issuer transfer fee exceeds static top-up policy");
            stage = "base-top-up";
            await this.executor.send([
              deposit.instruction,
              this.client.position("split", key(p.market), this.owner, 0, needed),
            ]);
            log("static-base-top-up", { market: p.market, amount: needed });
          }
        } else {
          const before = await this.view(),
            market = await this.validateMarket(before, p),
            held = inventory(before, this.owner, p.market),
            target = units(p.baseInventory, market.decimals[0]!),
            needed = target - min(held[2]!, held[3]!);
          if (needed > 0n) {
            const source = getAssociatedTokenAddressSync(NATIVE_MINT, this.owner),
              sourceInfo = await this.client.connection.getAccountInfo(source, "confirmed"),
              sourceAmount = sourceInfo
                ? BigInt((await this.client.connection.getTokenAccountBalance(source, "confirmed")).value.amount)
                : 0n,
              instructions = [
                createAssociatedTokenAccountIdempotentInstruction(
                  this.owner,
                  source,
                  this.owner,
                  NATIVE_MINT,
                  TOKEN_PROGRAM_ID,
                ),
              ];
            if (sourceAmount < needed) {
              instructions.push(
                SystemProgram.transfer({
                  fromPubkey: this.owner,
                  toPubkey: source,
                  lamports: needed - sourceAmount,
                }),
                createSyncNativeInstruction(source),
              );
            }
            if (sourceAmount < needed) {
              stage = "native-wrap";
              await this.executor.send(instructions);
            }
            const deposit = await this.client.depositForCredit(
              key(p.market),
              this.owner,
              NATIVE_MINT,
              0,
              needed,
            );
            stage = "native-top-up";
            await this.executor.send([
              deposit.instruction,
              this.client.position("split", key(p.market), this.owner, 0, needed),
            ]);
            log("static-native-top-up", { market: p.market, amount: needed });
          }
        }
        for (let step = 0; step < 4 * this.settings.quoteLevels; step++) {
          const s = await this.view(),
            m = await this.validateMarket(s, p),
            record = this.state.markets[p.market];
          if (!record?.fundComplete || !record.spot || !record.probability)
            throw new Error("Market lacks funded inventory or an observed reference");
          const desired = quotes({
            market: m,
            reference: {
              spot: BigInt(record.spot),
              probability: BigInt(record.probability),
              spread: 0n,
              observedAt: Date.now(),
            },
            gapBps: p.gapBps,
            balances: inventory(s, this.owner, p.market),
            targetBase: units(p.baseInventory, m.decimals[0]!),
            orderQuote: units(p.orderQuote, m.decimals[1]!),
            makerBps: s.config.maker_bps,
            movementBps: 0n,
            settings: this.settings,
            best: [{}, {}],
          });
          if (desired.length !== 4 * this.settings.quoteLevels)
            throw new Error("Inventory cannot back every requested static level");
          const now = BigInt(Math.floor(Date.now() / 1000)),
            minimumNonce = big(s.traders.get(this.owner.toBase58())?.minimum_nonce ?? bn(0)),
            missing = new Map(
              desired.map((q) => [
                `${q.branch}:${q.side}:${q.price}`,
                q,
              ]),
            );
          for (const [, existing] of owned(s, this.owner, p.market)) {
            const terms = existing.terms,
              id = `${terms.branch}:${terms.side}:${big(terms.price)}`,
              target = missing.get(id);
            if (
              !target ||
              terms.funding !== 1 ||
              terms.tif !== 0 ||
              !terms.recipient.equals(this.owner) ||
              terms.max_fee_bps !== s.config.maker_bps ||
              big(terms.nonce) < minimumNonce ||
              big(terms.expiry) <= now ||
              big(existing.remaining) <= 0n
            )
              throw new Error("Static seed found an incompatible existing order");
            missing.delete(id);
          }
          const q = missing.values().next().value as Quote | undefined;
          if (!q) break;
          const
            order = passiveOrder(
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
            available = wallet ? big(wallet.balances[fundingAsset(order)]!) : 0n,
            required = q.side === 0 ? quote(q.quantity, q.price, true) : q.quantity;
          if (available < required) throw new Error("Static order is not fully backed");
          const plan = planOrder({
            order,
            candidates: [],
            now: BigInt(Math.floor(Date.now() / 1000)),
            step: big(m.terms.step),
            nextSequence: big(m.sequence[q.branch]!),
            makerFeeBps: s.config.maker_bps,
            takerFeeBps: s.config.taker_bps,
            program: this.client.program,
          });
          stage = "execution";
          log("static-quote", {
            market: p.market,
            branch: q.branch,
            side: q.side,
            level: q.level,
            price: q.price,
            quantity: q.quantity,
          });
          await this.executor.send([this.client.placement(order, plan)]);
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
      await this.readReference(
        this.origin,
        this.client.deployment.genesisHash,
        m,
        p,
        this.settings,
      );
      record.fundStarted = true;
      this.save(); // Never automatically top up losses, including after restart.
      for (const collateral of [0, 1]) {
        const amount = units(
          collateral === 0 ? p.baseInventory : p.quoteInventory,
          m.decimals[collateral]!,
        );
        const deposit = await this.client.depositForCredit(
          key(p.market),
          this.owner,
          m.mints[collateral]!,
          collateral,
          amount,
        );
        if (deposit.fee * BPS > deposit.gross * BigInt(this.settings.maxTransferFeeBps))
          throw new Error("Issuer transfer fee exceeds funding policy");
        const instructions = [];
        if (!(await this.client.wallet(key(p.market), this.owner)))
          instructions.push(this.client.initializeWallet(key(p.market), this.owner));
        instructions.push(
          deposit.instruction,
          this.client.position("split", key(p.market), this.owner, collateral, amount),
        );
        await this.executor.send(instructions, false, () => !this.stopped);
      }
      record.fundComplete = true;
      this.save();
      log("funded", { market: p.market });
    }
  }
}
