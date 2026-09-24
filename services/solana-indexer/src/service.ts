/** Indexer service over a live (Geyser-streamed) chain index.
 *
 * Trading reads (markets, order books, orders, SSE) are served from the
 * confirmed view, within one block of a transaction landing. Custody reads
 * (balances, positions, payouts, reconciliation, resolutions) and durable
 * persistence use the finalized view. Finalized work runs in one ordered,
 * coalescing worker so the stream is never blocked on the database. */
import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import {
  hex,
  key,
  type MarketAccount,
  type OrderAccount,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import type { Hono } from "hono";
import { reconcileLedger } from "./custody.ts";
import {
  creationTimes,
  decodeHistory,
  eventInDeployment,
  persistStreamedHistory,
  replayHistory,
} from "./history.ts";
import type { CommitNotice } from "./live/index.ts";
import { compactOrderbooks } from "./orderbook-levels.ts";
import { payoutCredits } from "./payouts.ts";
import { indexedOrder, liveOrder, marketView, type Snapshot } from "./projection.ts";
import { reconcileVaults } from "./reconcile.ts";
import { RetiredOrders, retiredOrderImages, type RetiredOrderImage } from "./retired-orders.ts";
import { persistSnapshot } from "./storage.ts";
import { changedTopics, createIndexStream, legEvent } from "./stream.ts";
import { WalletIndex } from "./wallet-index.ts";

/** What the service needs from the live index (a fake in tests). */
export interface LiveSource {
  start(): Promise<void>;
  stop(): void;
  confirmed(): Snapshot;
  finalized(): Snapshot;
  health(): {
    healthy: boolean;
    confirmedSlot: number;
    finalizedSlot: number;
    lastMessageAgeMs: number;
  };
  rawAccounts(commitment: "confirmed" | "finalized"): { address: string; data: string }[];
  refreshLegs(): void;
}

export interface ConfirmedTrade {
  signature: string;
  event_index: number;
  slot: number;
  block_time: number | null;
  market: string | null;
  data: Record<string, unknown>;
}

/** Durable-side operations (injectable in tests). */
export interface ServiceDependencies {
  replayHistory: typeof replayHistory;
  persistStreamedHistory: typeof persistStreamedHistory;
  reconcileVaults: typeof reconcileVaults;
  persistSnapshot: typeof persistSnapshot;
}

export interface ServiceOptions {
  dependencies?: Partial<ServiceDependencies>;
  /** Minimum ms between finalized snapshot persists (coalesced). */
  persistIntervalMs?: number;
  /** Maximum ms between full vault reconciliations. */
  auditIntervalMs?: number;
  /** Confirmed trades kept in memory until they finalize. */
  tradeTail?: number;
}

export class IndexerService {
  historyReady = false;
  private historyGap = false;
  persistError: string | null = null;
  reconciliation: Awaited<ReturnType<typeof reconcileVaults>> | undefined;
  private lastAudit = 0;
  private lastPersist = 0;
  private createdAt = new Map<string, string>();
  private readonly retired = new RetiredOrders();
  private retiredImages: RetiredOrderImage[] = [];
  private confirmedTrades: ConfirmedTrade[] = [];
  private queue: CommitNotice[] = [];
  private draining: Promise<void> | undefined;
  readonly stream = createIndexStream();
  readonly wallets: WalletIndex;
  private readonly deps: ServiceDependencies;

  constructor(
    readonly client: SolanaClient,
    readonly db: SolanaDatabase,
    readonly domain: string,
    readonly live: LiveSource,
    private readonly options: ServiceOptions = {},
  ) {
    this.wallets = new WalletIndex(client, db, domain, () => this.custody());
    this.deps = {
      replayHistory,
      persistStreamedHistory,
      reconcileVaults,
      persistSnapshot,
      ...options.dependencies,
    };
  }

  /** Bootstraps the live index, then backfills finalized history to its base. */
  async start() {
    await this.live.start();
    const base = this.live.finalized();
    await this.deps.replayHistory(this.db, this.client, this.domain, base.slot, base);
    await this.refreshArchival(base);
    await this.persist(base, true);
    this.historyReady = true;
    void this.drain();
  }

  /** A stream gap re-bootstrapped the index: backfill history to the new base. */
  onResync() {
    this.historyGap = true;
  }

  onCommit(notice: CommitNotice) {
    if (notice.commitment === "finalized") {
      this.queue.push(notice);
      if (this.historyReady) void this.drain();
      return;
    }
    // Confirmed: publish trades and closed-order images immediately; the
    // finalized worker persists the same events once they are final.
    for (const tx of notice.transactions) {
      if (tx.response.meta?.err) continue;
      let events: ReturnType<typeof decodeHistory>["events"];
      try {
        events = decodeHistory(this.client, tx.response).events;
      } catch {
        continue; // Malformed logs are rejected by the finalized path.
      }
      for (const event of events) {
        if (!eventInDeployment(event, this.client, notice.snapshot)) continue;
        if (event.name === "Trade")
          this.confirmedTrades.push({
            signature: tx.signature,
            event_index: event.index,
            slot: tx.slot,
            block_time: tx.blockTime,
            market: event.market,
            data: event.data,
          });
        if (event.name === "OrderRetired")
          try {
            this.retired.add(notice.snapshot, retiredOrderImages([{ data: event.data }]));
          } catch {
            // Invalid images fail the finalized (archival) path loudly instead.
          }
      }
    }
    const limit = this.options.tradeTail ?? 2000;
    if (this.confirmedTrades.length > limit)
      this.confirmedTrades = this.confirmedTrades.slice(-limit);
    this.stream.publish(changedTopics(notice.previous, notice.snapshot, notice.changed));
  }

  /** Ordered, coalescing finalized worker. The running pass is cleared
   * asynchronously, so an empty pass can never leave a settled promise behind
   * that would make later drains no-ops. */
  drain(): Promise<void> {
    if (!this.draining) {
      const pass: Promise<void> = this.work().finally(() => {
        if (this.draining === pass) this.draining = undefined;
      });
      this.draining = pass;
    }
    return this.draining;
  }

  private async work() {
    while (this.queue.length) {
      const batch = this.queue.splice(0);
      const last = batch.at(-1)!;
      const transactions = batch.flatMap((n) => n.transactions);
      try {
        if (this.historyGap) {
          await this.deps.replayHistory(
            this.db,
            this.client,
            this.domain,
            last.slot,
            last.snapshot,
          );
          this.historyGap = false;
        } else
          await this.deps.persistStreamedHistory(
            this.db,
            this.client,
            this.domain,
            last.slot,
            last.snapshot,
            transactions,
          );
        const finalizedSlot = last.slot;
        this.confirmedTrades = this.confirmedTrades.filter((t) => t.slot > finalizedSlot);
        if (transactions.length) await this.refreshArchival(last.snapshot);
        reconcileLedger(last.snapshot);
        await this.persist(last.snapshot, false, batch);
        const owners = new Set(
          batch.flatMap((n) => changedTopics(n.previous, n.snapshot, n.changed).owners),
        );
        void this.wallets.refreshOwners([...owners]);
        this.persistError = null;
      } catch (error) {
        this.persistError = error instanceof Error ? error.message : String(error);
        this.historyGap = true; // Re-derive history from RPC on the next pass.
        await this.db.failSnapshot(this.domain, last.slot).catch(() => {});
      }
    }
  }

  /** Market creation times and retired orders come from finalized history. */
  private async refreshArchival(s: Snapshot) {
    this.createdAt = creationTimes(await this.db.creationEvents(this.domain, s.slot));
    this.retiredImages = retiredOrderImages(await this.db.retiredEvents(this.domain, s.slot));
    this.retired.add(s, this.retiredImages);
  }

  private async persist(s: Snapshot, force: boolean, batch: CommitNotice[] = []) {
    const now = Date.now();
    const auditDue =
      force ||
      now - this.lastAudit >= (this.options.auditIntervalMs ?? 30_000) ||
      batch.some((n) =>
        [...n.changed].some((a) => n.snapshot.pools.has(a) || n.snapshot.markets.has(a)),
      );
    if (auditDue) {
      this.reconciliation = await this.deps.reconcileVaults(this.client, s);
      this.lastAudit = now;
    }
    if (!force && now - this.lastPersist < (this.options.persistIntervalMs ?? 1000)) return;
    const image: Snapshot = {
      ...s,
      rawAccounts: this.live.rawAccounts("finalized"),
      createdAt: this.createdAt,
    };
    if (!(await this.deps.persistSnapshot(this.db, this.domain, image, this.retiredImages)))
      throw new Error("A newer indexer snapshot is already committed");
    this.lastPersist = now;
  }

  /** Confirmed view for trading reads. */
  trading(): Snapshot {
    if (!this.live.health().healthy) throw new Error("Live chain stream unavailable");
    const s = this.live.confirmed();
    return this.createdAt.size ? { ...s, createdAt: this.createdAt } : s;
  }

  /** Finalized, persisted view for custody reads. */
  custody(): Snapshot {
    if (!this.live.health().healthy) throw new Error("Live chain stream unavailable");
    if (!this.historyReady) throw new Error("Finalized history is still being indexed");
    if (this.persistError)
      throw new Error("Finalized indexer persistence failed: " + this.persistError);
    return { ...this.live.finalized(), createdAt: this.createdAt };
  }

  /** Recent confirmed (not yet finalized) trades, newest first. */
  confirmedTail(markets: ReadonlySet<string>) {
    return this.confirmedTrades.filter((t) => t.market !== null && markets.has(t.market)).reverse();
  }

  ordersWithRetired(s: Snapshot): Iterable<[string, OrderAccount]> {
    const retired = this.retired;
    return (function* () {
      yield* s.orders;
      yield* retired.entries(s.orders);
    })();
  }

  mount(app: Hono) {
    const { db, domain } = this;
    this.stream.mount(app, () => this.trading(), this.wallets);
    app.get("/health", (c) => {
      const health = this.live.health();
      const s = this.trading();
      return c.json({
        healthy: true,
        chain: "solana",
        head: {
          confirmedBlock: String(health.confirmedSlot),
          finalizedBlock: String(health.finalizedSlot),
        },
        streamLagMs: health.lastMessageAgeMs,
        slot: String(s.slot),
      });
    });
    app.get("/reconciliation", (c) => {
      this.custody();
      if (!this.reconciliation) throw new Error("Vault reconciliation is not available");
      return c.json(this.reconciliation);
    });
    app.get("/markets", (c) => {
      const s = this.trading();
      return c.json({
        markets: [...s.markets].map(([id, m]) =>
          marketView(id, m, s.createdAt?.get(id), s.legs?.get(id)),
        ),
        slot: String(s.slot),
        confirmation: "confirmed",
      });
    });
    app.get("/markets/:id", (c) => {
      const id = c.req.param("id"),
        s = this.trading(),
        m = s.markets.get(id);
      return m
        ? c.json(marketView(id, m, s.createdAt?.get(id), s.legs?.get(id)))
        : c.json({ error: "not-found" }, 404);
    });
    /** Base-leg listings (kind 15, amount = scale) and delist/relist toggles
     * (kind 16, amount 0/1) from finalized history, oldest first. */
    app.get("/markets/:id/leg-events", async (c) => {
      const id = c.req.param("id"),
        s = this.custody();
      if (!s.markets.has(id)) return c.json({ error: "not-found" }, 404);
      const rows = await db.legEvents(domain, id, s.slot);
      return c.json({
        events: rows.map((r) => legEvent(r.signature, r.event_index, r.block_time, r.data)),
        slot: String(s.slot),
      });
    });
    app.get("/orders", (c) => {
      const s = this.trading(),
        maker = c.req.query("maker"),
        status = c.req.query("status");
      const rows = [...this.ordersWithRetired(s)].filter(
        ([, o]) =>
          (!maker || o.owner.toBase58() === maker) &&
          (!status || status !== "open" || o.status === 1),
      );
      return c.json({
        orders: rows.map(([id, o]) => ({
          ...indexedOrder(id, o, s.slot),
          confirmation: "confirmed",
        })),
        truncated: false,
        nextCursor: null,
      });
    });
    app.get("/orderbook/:id", (c) => {
      const s = this.trading(),
        id = c.req.param("id");
      return c.json({
        orders: [...s.orders]
          .filter(([, o]) => o.market.toBase58() === id && liveOrder(o, s))
          .map(([orderId, o]) => ({
            ...indexedOrder(orderId, o, s.slot),
            confirmation: "confirmed",
          })),
        truncated: false,
        slot: String(s.slot),
      });
    });
    app.get("/orderbooks", (c) => {
      const s = this.trading();
      if (c.req.query("view") === "levels")
        return c.json({
          books: compactOrderbooks(
            s.markets.keys(),
            [...s.orders.values()]
              .filter((order) => liveOrder(order, s))
              .map((order) => ({
                market: order.market.toBase58(),
                branch: order.terms.branch,
                side: order.terms.side,
                limitPriceRawX18: order.terms.price.toString(),
                remaining: order.remaining.toString(),
                bases: order.terms.bases,
              })),
          ),
          slot: String(s.slot),
        });
      const books: Record<string, { orders: ReturnType<typeof indexedOrder>[]; truncated: false }> =
        {};
      for (const id of s.markets.keys()) books[id] = { orders: [], truncated: false };
      for (const [id, order] of s.orders) {
        if (!liveOrder(order, s)) continue;
        books[order.market.toBase58()]?.orders.push({
          ...indexedOrder(id, order, s.slot),
          confirmation: "confirmed",
        });
      }
      return c.json({ books, slot: String(s.slot) });
    });
    app.get("/positions/:owner", async (c) => {
      this.custody();
      const owner = key(c.req.param("owner")).toBase58();
      c.header("Cache-Control", "no-store");
      const response = await this.wallets.get(owner);
      this.custody(); // Don't publish cached wallet reads after integrity/readiness failed.
      return c.json(response);
    });
    app.get("/balances/:owner", async (c) => {
      const owner = key(c.req.param("owner")),
        mint = key(c.req.query("token") ?? "");
      this.custody();
      c.header("Cache-Control", "no-store");
      const image = await this.wallets.get(owner.toBase58());
      const response = image.balances[mint.toBase58()];
      if (!response) return c.json({ error: "Mint is not indexed for this deployment" }, 404);
      this.custody();
      return c.json(response);
    });
    app.get("/payouts/:owner", (c) =>
      c.json({
        vault: this.client.program.toBase58(),
        payouts: payoutCredits(this.custody(), key(c.req.param("owner")).toBase58()),
        nextCursor: null,
      }),
    );
    app.get("/resolutions/:id", async (c) => {
      const s = this.custody();
      const m: MarketAccount | undefined = s.markets.get(c.req.param("id"));
      if (!m || ![6, 7].includes(m.state)) return c.json({ error: "not-found" }, 404);
      const event = await db.resolutionEvent(domain, c.req.param("id"), s.slot);
      if (!event) throw new Error("Resolution transaction has not been indexed");
      return c.json({
        admin: event.data.account,
        evidenceHash: hex(m.evidence),
        evidenceUri: m.evidence_uri,
        yesPayout: String(m.payouts[0]),
        noPayout: String(m.payouts[1]),
        payoutDenominator: String(m.payouts[0]! + m.payouts[1]!),
        transactionHash: event.signature,
      });
    });
    app.get("/trades", async (c) => {
      const s = this.custody(),
        market = c.req.query("marketId"),
        limit = Number(c.req.query("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        return c.json({ error: "Invalid limit" }, 400);
      const live = this.trading();
      if (market && !live.markets.has(market)) return c.json({ trades: [] });
      const markets = new Set(market ? [market] : [...live.markets.keys()]);
      const rows = await db.trades(domain, [...markets], s.slot, limit);
      const seen = new Set(rows.map((r) => r.signature + ":" + r.event_index));
      const tail = this.confirmedTail(markets).filter(
        (t) => !seen.has(t.signature + ":" + t.event_index),
      );
      const view = (
        r: {
          signature: string;
          event_index: number;
          market: string | null;
          block_time: string | number | null;
          data: Record<string, unknown>;
        },
        confirmation: string,
      ) => ({
        id: r.signature + ":" + r.event_index,
        marketId: r.market,
        branch: r.data.branch,
        blockTimestamp: r.block_time === null ? null : String(r.block_time),
        executionPriceRawX18: r.data.price,
        fillQuantity: r.data.quantity,
        /** Issuer leg (collateral) the buyer received and its raw claim units. */
        base: r.data.base,
        baseAmount: r.data.base_amount,
        executionQuote: r.data.quote,
        makerOrderHash: r.data.maker,
        takerOrderHash: r.data.taker,
        transactionHash: r.signature,
        confirmation,
      });
      return c.json({
        trades: [
          ...tail.map((t) => view(t, "confirmed")),
          ...rows.map((r) => view(r, "finalized")),
        ].slice(0, limit),
      });
    });
    app.get("/lookup-tables", async (c) => {
      c.header("cache-control", "no-store");
      return c.json({ tables: await db.lookupTables(domain) });
    });
  }
}
