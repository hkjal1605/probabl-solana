import type {
  MetadataSnapshot,
  PolymarketQueries,
  SubscriptionRecord,
} from "@conditional-stocks/db/polymarket";
import {
  MarketDataError,
  normalizeGammaMarket,
  object,
  PolymarketYesBook,
  type ProbabilityTick,
  requiredString,
  yesOutcome,
} from "@conditional-stocks/market-data";
import { type Hex, isHex } from "viem";
import type { PolymarketEnvironment } from "./environment.ts";
import { logger } from "./logger.ts";
import type { PolymarketSocket, PolymarketSource } from "./source.ts";

type TickListener = (tick: ProbabilityTick) => void;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_PENDING_SOURCE_EVENTS = 1_000;
const NON_RESOLUTION_STATUSES = new Set(["active", "open", "unresolved"]);

const condition = (value: unknown): Hex => {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new MarketDataError("INVALID_REQUEST", "conditionId must be bytes32");
  }
  return value.toLowerCase() as Hex;
};

export class PolymarketIngestor {
  readonly #books = new Map<Hex, PolymarketYesBook>();
  readonly #listeners = new Map<Hex, Set<TickListener>>();
  readonly #quality = new Map<Hex, ProbabilityTick["quality"]>();
  #metadataTimer: ReturnType<typeof setInterval> | null = null;
  #eventQueue: Promise<void> = Promise.resolve();
  #pendingSourceEvents = 0;
  #socketGeneration = 0;
  readonly #bookQueues = new Map<Hex, Promise<unknown>>();
  #socketQueue: Promise<void> = Promise.resolve();
  #reconcilePass: Promise<void> | null = null;
  #metadataPass: Promise<void> | null = null;
  #reconnectDelayMs = RECONNECT_MIN_MS;
  #reconcileTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #socket: PolymarketSocket | null = null;
  #stopped = true;

  constructor(
    readonly environment: PolymarketEnvironment,
    readonly store: PolymarketQueries,
    readonly source: PolymarketSource,
  ) {}

  async fetchMetadata(gammaMarketIdInput: unknown): Promise<MetadataSnapshot> {
    const gammaMarketId = requiredString(gammaMarketIdInput, "gammaMarketId", 256);
    const raw = await this.source.getMarket(gammaMarketId);
    const normalized = normalizeGammaMarket(raw);
    if (normalized.gammaMarketId !== gammaMarketId) {
      throw new MarketDataError(
        "MAPPING_MISMATCH",
        "Gamma response market ID does not match request",
      );
    }
    const previous = await this.store.latestMetadataByGammaId(gammaMarketId);
    const snapshot = await this.store.appendMetadata(raw, normalized);
    logger.debug("polymarket.metadata.fetched", {
      gammaMarketId,
      conditionId: normalized.conditionId,
      sourceHash: snapshot.rawHash,
    });
    if (previous && previous.normalized.mappingHash !== normalized.mappingHash) {
      await this.#alert("METADATA_MAPPING_CHANGED", normalized.conditionId, {
        current: normalized.mappingHash,
        previous: previous.normalized.mappingHash,
        snapshotId: snapshot.snapshotId,
      });
    } else if (previous && JSON.stringify(previous.normalized) !== JSON.stringify(normalized)) {
      await this.#alert("METADATA_CHANGED", normalized.conditionId, {
        currentSnapshotId: snapshot.snapshotId,
        previousSnapshotId: previous.snapshotId,
      });
    }
    const resolutionReview =
      normalized.resolutionStatus !== null &&
      !NON_RESOLUTION_STATUSES.has(normalized.resolutionStatus.toLowerCase());
    if (
      (normalized.closed || resolutionReview) &&
      (!previous ||
        previous.normalized.closed !== normalized.closed ||
        previous.normalized.resolutionStatus !== normalized.resolutionStatus)
    ) {
      await this.#alert("MANUAL_LIFECYCLE_REVIEW_REQUIRED", normalized.conditionId, {
        closed: normalized.closed,
        resolutionStatus: normalized.resolutionStatus,
      });
    }
    return snapshot;
  }

  async track(metadataSnapshotIdInput: unknown): Promise<SubscriptionRecord> {
    const metadataSnapshotId = requiredString(metadataSnapshotIdInput, "metadataSnapshotId", 256);
    const snapshot = await this.store.metadata(metadataSnapshotId);
    if (!snapshot) throw new MarketDataError("NOT_FOUND", "metadata snapshot not found", 404);
    const yes = yesOutcome(snapshot.normalized);
    const record = await this.store.addSubscription({
      conditionId: snapshot.normalized.conditionId,
      gammaMarketId: snapshot.normalized.gammaMarketId,
      metadataSnapshotId,
      yesTokenId: yes.tokenId,
    });
    this.#ensureBook(record);
    await this.reconcile(record.conditionId);
    await this.#restartSocket();
    logger.info("polymarket.subscription.tracked", {
      conditionId: record.conditionId,
      gammaMarketId: record.gammaMarketId,
    });
    return record;
  }

  async reconcile(conditionIdInput: unknown): Promise<ProbabilityTick> {
    const conditionId = condition(conditionIdInput);
    return this.#serialBook(conditionId, () => this.#reconcile(conditionId));
  }

  async #reconcile(conditionId: Hex, isCurrent = () => true): Promise<ProbabilityTick> {
    const subscription = await this.store.subscription(conditionId);
    const book = this.#books.get(conditionId);
    if (!subscription || !book)
      throw new MarketDataError("NOT_FOUND", "subscription not found", 404);
    const raw = await this.source.getBook(subscription.yesTokenId);
    if (!isCurrent()) return book.tick();
    const result = book.applySnapshot(raw);
    const tick = result.tick ?? book.tick();
    await this.#publish(tick);
    return tick;
  }

  async applySourceEvent(input: unknown): Promise<void> {
    const raw = object(input, "source event");
    const conditionId = condition(raw.market);
    return this.#serialBook(conditionId, () => this.#applySourceEvent(raw));
  }

  async #applySourceEvent(input: unknown, isCurrent = () => true): Promise<void> {
    const raw = object(input, "source event");
    this.#reconnectDelayMs = RECONNECT_MIN_MS;
    const eventType = requiredString(raw.event_type, "event_type", 64);
    if (eventType === "market_resolved") {
      const conditionId = condition(raw.market);
      await this.#alert("RESOLUTION_EVENT_REQUIRES_HUMAN_REVIEW", conditionId, raw);
      return;
    }
    const conditionId = condition(raw.market);
    const book = this.#books.get(conditionId);
    const subscription = await this.store.subscription(conditionId);
    if (!isCurrent()) return;
    if (!book || !subscription) return;
    const result = book.applyWebSocket(raw);
    if (result.requiresSnapshot) {
      await this.#alert("WEBSOCKET_GAP", conditionId, { eventType });
      await this.#reconcile(conditionId, isCurrent);
      return;
    }
    if (result.tick) await this.#publish(result.tick);
  }

  async ingestSourceEvent(input: unknown, generation?: number): Promise<void> {
    const isCurrent = () =>
      generation === undefined || (!this.#stopped && generation === this.#socketGeneration);
    if (!isCurrent()) return;
    if (this.#pendingSourceEvents >= MAX_PENDING_SOURCE_EVENTS)
      throw new MarketDataError(
        "SOURCE_BACKPRESSURE",
        "Source event backlog requires a fresh snapshot",
        503,
      );
    const raw = object(input, "source event");
    const conditionId = condition(raw.market);
    this.#pendingSourceEvents++;
    // Separate markets progress concurrently; each book retains exact event ordering.
    const pending = this.#serialBook(conditionId, async () => {
      if (isCurrent()) await this.#applySourceEvent(raw, isCurrent);
    }).finally(() => {
      this.#pendingSourceEvents--;
    });
    this.#eventQueue = Promise.allSettled([this.#eventQueue, pending]).then(() => undefined);
    return pending;
  }

  async metadata(snapshotId: string): Promise<MetadataSnapshot | null> {
    return await this.store.metadata(snapshotId);
  }

  async latestMetadata(conditionIdInput: unknown): Promise<MetadataSnapshot | null> {
    return await this.store.latestMetadataByCondition(condition(conditionIdInput));
  }

  async probability(conditionIdInput: unknown): Promise<ProbabilityTick> {
    const conditionId = condition(conditionIdInput);
    const book = this.#books.get(conditionId);
    const stored = book ? null : await this.store.latestTick(conditionId);
    const tick =
      book?.tick() ??
      (stored ? { ...stored, isStale: true, quality: "disconnected" as const } : null);
    if (!tick) throw new MarketDataError("NOT_FOUND", "probability is unavailable", 404);
    this.#observeQuality(tick);
    return tick;
  }

  subscribe(conditionIdInput: unknown, listener: TickListener): () => void {
    const conditionId = condition(conditionIdInput);
    const listeners = this.#listeners.get(conditionId) ?? new Set<TickListener>();
    listeners.add(listener);
    this.#listeners.set(conditionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(conditionId);
    };
  }

  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    for (const record of await this.store.subscriptions()) this.#ensureBook(record);
    await Promise.allSettled(
      (await this.store.subscriptions()).map((record) =>
        this.reconcile(record.conditionId).catch((error) => {
          logger.warn("polymarket.bootstrap.failed", { conditionId: record.conditionId, error });
        }),
      ),
    );
    await this.#restartSocket();
    this.#reconcileTimer = setInterval(() => {
      if (this.#reconcilePass) return;
      this.#reconcilePass = this.reconcileAll()
        .catch((error) => logger.error("polymarket.reconciliation.failed", { error }))
        .finally(() => {
          this.#reconcilePass = null;
        });
    }, this.environment.reconcileMs);
    this.#metadataTimer = setInterval(() => {
      if (this.#metadataPass) return;
      this.#metadataPass = this.reconcileMetadata()
        .catch((error) => logger.error("polymarket.metadata.failed", { error }))
        .finally(() => {
          this.#metadataPass = null;
        });
    }, this.environment.metadataPollMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#socketGeneration++;
    this.#socket?.close();
    this.#socket = null;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    if (this.#metadataTimer) clearInterval(this.#metadataTimer);
    await Promise.allSettled([
      this.#eventQueue,
      this.#socketQueue,
      this.#reconcilePass,
      this.#metadataPass,
      ...this.#bookQueues.values(),
    ]);
  }

  async reconcileAll(): Promise<void> {
    await Promise.all(
      (await this.store.subscriptions()).map(async (record) => {
        try {
          await this.reconcile(record.conditionId);
        } catch (error) {
          const book = this.#books.get(record.conditionId);
          if (book) await this.#publish(book.disconnect());
          await this.#alert("REST_RECONCILIATION_FAILED", record.conditionId, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  async reconcileMetadata(): Promise<void> {
    await Promise.all(
      (await this.store.subscriptions()).map(async (record) => {
        try {
          await this.fetchMetadata(record.gammaMarketId);
        } catch (error) {
          await this.#alert("METADATA_RECONCILIATION_FAILED", record.conditionId, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  #ensureBook(record: SubscriptionRecord): void {
    if (this.#books.has(record.conditionId)) return;
    this.#books.set(
      record.conditionId,
      new PolymarketYesBook(record.conditionId, record.yesTokenId, {
        staleAfterMs: this.environment.staleAfterMs,
        standardNotionalX6: this.environment.standardNotionalX6,
      }),
    );
  }

  async #publish(tick: ProbabilityTick): Promise<void> {
    await this.store.saveLatestTick(tick);
    this.#observeQuality(tick);
    logger.debug("polymarket.tick", {
      conditionId: tick.conditionId,
      quality: tick.quality,
      midpointX6: tick.midpointX6,
      observedAtMs: tick.observedAtMs,
      sourceHash: tick.sourceHash,
    });
    for (const listener of this.#listeners.get(tick.conditionId) ?? []) {
      try {
        listener(tick);
      } catch (error) {
        logger.warn("polymarket.listener.failed", { error });
      }
    }
  }

  async #restartSocket(): Promise<void> {
    const pending = this.#socketQueue.then(() => this.#connectSocket());
    this.#socketQueue = pending.catch(() => undefined);
    return pending;
  }

  async #connectSocket(): Promise<void> {
    const generation = ++this.#socketGeneration;
    this.#socket?.close();
    this.#socket = null;
    if (this.#stopped) return;
    const tokenIds = (await this.store.subscriptions()).map((record) => record.yesTokenId);
    if (this.#stopped || tokenIds.length === 0) return;
    logger.info("polymarket.socket.connecting", { subscriptions: tokenIds.length });
    this.#socket = this.source.connect(
      tokenIds,
      (event) =>
        void this.ingestSourceEvent(event, generation)
          .catch(async (error) => {
            if (generation !== this.#socketGeneration || this.#stopped) return;
            // A dropped/rejected event breaks continuity. Fence the old socket immediately
            // and recover through REST instead of keeping a potentially incorrect live book.
            this.#disconnectSocket(
              generation,
              error instanceof MarketDataError ? error.code : "event rejected",
            );
            await this.#alert("WEBSOCKET_EVENT_REJECTED", null, {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .catch((error) => logger.error("polymarket.alert.failed", { error })),
      (reason) => this.#disconnectSocket(generation, reason),
    );
  }

  #disconnectSocket(generation: number, reason: string): void {
    if (this.#stopped || generation !== this.#socketGeneration) return;
    this.#socketGeneration++;
    this.#socket?.close();
    this.#socket = null;
    for (const book of this.#books.values()) book.disconnect();
    const pending = this.#handleDisconnect(reason).catch((error) =>
      logger.error("polymarket.disconnect.failed", { error }),
    );
    this.#eventQueue = Promise.allSettled([this.#eventQueue, pending]).then(() => undefined);
  }

  async #handleDisconnect(reason: string): Promise<void> {
    const retryInMs = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, RECONNECT_MAX_MS);
    for (const [conditionId, book] of this.#books) {
      await this.#serialBook(conditionId, () => this.#publish(book.disconnect()));
      await this.#alert("WEBSOCKET_DISCONNECTED", conditionId, { reason, retryInMs });
    }
    if (!this.#stopped && !this.#reconnectTimer) {
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null;
        this.#reconcilePass = (this.#reconcilePass ?? this.reconcileAll())
          .then(() => this.#restartSocket())
          .catch((error) => logger.error("polymarket.reconnect.failed", { error }))
          .finally(() => {
            this.#reconcilePass = null;
          });
      }, retryInMs);
    }
  }

  async #alert(...args: Parameters<PolymarketQueries["appendAlert"]>) {
    const alert = await this.store.appendAlert(...args);
    logger.warn("polymarket.alert", {
      alertId: alert.id,
      code: alert.code,
      conditionId: alert.conditionId,
    });
    return alert;
  }

  #serialBook<T>(conditionId: Hex, work: () => Promise<T>): Promise<T> {
    const pending = (this.#bookQueues.get(conditionId) ?? Promise.resolve()).then(work);
    const tail = pending.catch(() => undefined);
    this.#bookQueues.set(conditionId, tail);
    void tail.then(() => {
      if (this.#bookQueues.get(conditionId) === tail) this.#bookQueues.delete(conditionId);
    });
    return pending;
  }

  #observeQuality(tick: ProbabilityTick): void {
    const previousQuality = this.#quality.get(tick.conditionId);
    if (previousQuality === tick.quality) return;
    this.#quality.set(tick.conditionId, tick.quality);
    const fields = {
      conditionId: tick.conditionId,
      previousQuality,
      quality: tick.quality,
      midpointX6: tick.midpointX6,
      observedAtMs: tick.observedAtMs,
    };
    if (tick.isStale || tick.quality === "disconnected")
      logger.warn("polymarket.quality.changed", fields);
    else logger.info("polymarket.quality.changed", fields);
  }
}

export const parseMetadataFetchRequest = (input: unknown): string =>
  requiredString(object(input, "body").gammaMarketId, "gammaMarketId", 256);

export const parseTrackRequest = (input: unknown): string =>
  requiredString(object(input, "body").metadataSnapshotId, "metadataSnapshotId", 256);
