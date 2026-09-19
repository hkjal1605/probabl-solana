import type { Hex } from "./canonical.ts";

import { hashCanonical, MarketDataError, object, requiredString } from "./canonical.ts";

export const POLYMARKET_SCALE = 1_000_000n;

export type ProbabilityQuality =
  | "crossed"
  | "disconnected"
  | "empty"
  | "low-depth"
  | "one-sided"
  | "stale"
  | "valid";

export interface ProbabilityPolicy {
  staleAfterMs: bigint;
  standardNotionalX6: bigint;
}

export interface ProbabilityTick {
  askDepthQuoteX6: string;
  bestAskX6: string | null;
  bestBidX6: string | null;
  bidDepthQuoteX6: string;
  conditionId: Hex;
  isStale: boolean;
  midpointX6: string | null;
  observedAtMs: string;
  quality: ProbabilityQuality;
  schemaVersion: 1;
  sourceHash: string;
  spreadX6: string | null;
  standardNotionalX6: string;
  yesTokenId: string;
}

export interface ApplyResult {
  applied: boolean;
  duplicate: boolean;
  requiresSnapshot: boolean;
  tick: ProbabilityTick | null;
}

const fixed = (value: unknown, name: string): bigint => {
  if (
    typeof value !== "string" ||
    value.length > 85 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)
  ) {
    throw new MarketDataError("INVALID_BOOK", `${name} must have at most six decimals`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * POLYMARKET_SCALE + BigInt(fraction.padEnd(6, "0"));
};

const timestamp = (value: unknown, name: string): bigint => {
  const parsed = fixed(requiredString(value, name, 32), name);
  // A timestamp is an integer; fixed() is reused only for strict decimal parsing.
  if (parsed % POLYMARKET_SCALE !== 0n) {
    throw new MarketDataError("INVALID_BOOK", `${name} must be an integer`);
  }
  const raw = parsed / POLYMARKET_SCALE;
  return raw < 10_000_000_000n ? raw * 1_000n : raw;
};

const sequence = (value: unknown): bigint | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new MarketDataError("INVALID_BOOK", "sequence must be an integer string");
  }
  return BigInt(value);
};

const levels = (value: unknown, name: string): Array<[bigint, bigint]> => {
  if (!Array.isArray(value)) throw new MarketDataError("INVALID_BOOK", `${name} must be an array`);
  return value.map((item, index) => {
    const level = object(item, `${name}[${index}]`);
    const price = fixed(level.price, `${name}[${index}].price`);
    const size = fixed(level.size, `${name}[${index}].size`);
    if (price <= 0n || price >= POLYMARKET_SCALE || size < 0n) {
      throw new MarketDataError("INVALID_BOOK", `${name}[${index}] is outside valid bounds`);
    }
    return [price, size];
  });
};

const quoteDepth = (book: Map<bigint, bigint>, cap: bigint): bigint => {
  let total = 0n;
  for (const [price, size] of book) {
    total += (price * size) / POLYMARKET_SCALE;
    if (total >= cap) return cap;
  }
  return total;
};

export class PolymarketYesBook {
  readonly #asks = new Map<bigint, bigint>();
  readonly #bids = new Map<bigint, bigint>();
  readonly #seen = new Set<Hex>();
  #connected = true;
  #lastSequence: bigint | null = null;
  #observedAtMs = 0n;
  #sourceAtMs = 0n;
  #sourceHash = "";

  constructor(
    readonly conditionId: Hex,
    readonly yesTokenId: string,
    readonly policy: ProbabilityPolicy,
  ) {
    if (policy.staleAfterMs <= 0n || policy.standardNotionalX6 <= 0n) {
      throw new MarketDataError("INVALID_POLICY", "probability policy values must be positive");
    }
  }

  applySnapshot(input: unknown, nowMs = BigInt(Date.now())): ApplyResult {
    const raw = object(input, "snapshot");
    this.#assertIdentity(raw);
    const eventDigest = hashCanonical(raw);
    const duplicate = this.#seen.has(eventDigest);
    const sourceAtMs = timestamp(raw.timestamp, "timestamp");
    if (sourceAtMs > nowMs + 5_000n)
      throw new MarketDataError("INVALID_BOOK", "snapshot timestamp is in the future");
    if (sourceAtMs < this.#sourceAtMs) return this.#result(false, false, true, nowMs);
    // REST is the authoritative recovery source and must replace local state even when a
    // repeated payload hash was seen before a WebSocket delta.
    const bids = levels(raw.bids, "bids");
    const asks = levels(raw.asks, "asks");
    const sourceHash = requiredString(raw.hash, "hash", 512);
    const nextSequence = sequence(raw.sequence);
    this.#replace(this.#bids, bids);
    this.#replace(this.#asks, asks);
    this.#sourceAtMs = sourceAtMs;
    // A successful REST read proves that this unchanged book is still the
    // authoritative current snapshot. Keep the source-change timestamp only
    // for ordering; freshness is based on when we actually observed it.
    this.#observedAtMs = nowMs;
    this.#sourceHash = sourceHash;
    this.#lastSequence = nextSequence;
    this.#connected = true;
    if (!duplicate) this.#remember(eventDigest);
    return { applied: !duplicate, duplicate, requiresSnapshot: false, tick: this.tick(nowMs) };
  }

  applyWebSocket(input: unknown, nowMs = BigInt(Date.now())): ApplyResult {
    const raw = object(input, "WebSocket event");
    const eventType = requiredString(raw.event_type, "event_type", 64);
    if (eventType === "book") return this.applySnapshot(raw, nowMs);
    if (eventType !== "price_change") return this.#result(false, false, false, nowMs);
    if (requiredString(raw.market, "market", 66).toLowerCase() !== this.conditionId.toLowerCase()) {
      throw new MarketDataError(
        "MAPPING_MISMATCH",
        "WebSocket condition does not match subscription",
      );
    }
    const eventDigest = hashCanonical(raw);
    if (this.#seen.has(eventDigest)) return this.#result(false, true, false, nowMs);
    const nextSequence = sequence(raw.sequence);
    if (
      nextSequence !== null &&
      this.#lastSequence !== null &&
      nextSequence !== this.#lastSequence + 1n
    ) {
      return this.#result(false, false, true, nowMs);
    }
    const observedAtMs = timestamp(raw.timestamp, "timestamp");
    if (observedAtMs < this.#sourceAtMs) return this.#result(false, false, true, nowMs);
    if (!Array.isArray(raw.price_changes)) {
      throw new MarketDataError("INVALID_BOOK", "price_changes must be an array");
    }
    const changes: Array<{ target: Map<bigint, bigint>; price: bigint; size: bigint }> = [];
    for (const [index, inputChange] of raw.price_changes.entries()) {
      const change = object(inputChange, `price_changes[${index}]`);
      if (requiredString(change.asset_id, "asset_id", 128) !== this.yesTokenId) continue;
      const price = fixed(change.price, "price");
      const size = fixed(change.size, "size");
      if (price <= 0n || price >= POLYMARKET_SCALE || size < 0n) {
        throw new MarketDataError("INVALID_BOOK", "price change is outside valid bounds");
      }
      const side = requiredString(change.side, "side", 8);
      const target = side === "BUY" ? this.#bids : side === "SELL" ? this.#asks : null;
      if (!target) throw new MarketDataError("INVALID_BOOK", "side must be BUY or SELL");
      changes.push({ target, price, size });
    }
    // Validate the entire event before changing any book level.
    for (const { target, price, size } of changes) {
      if (size === 0n) target.delete(price);
      else target.set(price, size);
    }
    this.#observedAtMs = observedAtMs;
    this.#sourceAtMs = observedAtMs;
    this.#sourceHash = eventDigest;
    this.#lastSequence = nextSequence ?? this.#lastSequence;
    this.#connected = true;
    this.#remember(eventDigest);
    return this.#result(true, false, false, nowMs);
  }

  disconnect(nowMs = BigInt(Date.now())): ProbabilityTick {
    this.#connected = false;
    return this.tick(nowMs);
  }

  tick(nowMs = BigInt(Date.now())): ProbabilityTick {
    const bids = [...this.#bids.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const asks = [...this.#asks.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const bestBid = bids[0] ?? null;
    const bestAsk = asks[0] ?? null;
    const stale =
      this.#observedAtMs === 0n ||
      this.#observedAtMs > nowMs + 5_000n ||
      nowMs - this.#observedAtMs > this.policy.staleAfterMs;
    const bidDepth = quoteDepth(this.#bids, this.policy.standardNotionalX6);
    const askDepth = quoteDepth(this.#asks, this.policy.standardNotionalX6);
    let quality: ProbabilityQuality = "valid";
    if (!this.#connected) quality = "disconnected";
    else if (stale) quality = "stale";
    else if (bestBid === null && bestAsk === null) quality = "empty";
    else if (bestBid === null || bestAsk === null) quality = "one-sided";
    else if (bestBid >= bestAsk) quality = "crossed";
    else if (
      bidDepth < this.policy.standardNotionalX6 ||
      askDepth < this.policy.standardNotionalX6
    ) {
      quality = "low-depth";
    }
    const usable = quality === "valid" && bestBid !== null && bestAsk !== null;
    return {
      askDepthQuoteX6: askDepth.toString(),
      bestAskX6: bestAsk?.toString() ?? null,
      bestBidX6: bestBid?.toString() ?? null,
      bidDepthQuoteX6: bidDepth.toString(),
      conditionId: this.conditionId,
      isStale: stale,
      midpointX6: usable ? ((bestBid + bestAsk) / 2n).toString() : null,
      observedAtMs: this.#observedAtMs.toString(),
      quality,
      schemaVersion: 1,
      sourceHash: this.#sourceHash,
      spreadX6:
        bestBid !== null && bestAsk !== null && bestAsk >= bestBid
          ? (bestAsk - bestBid).toString()
          : null,
      standardNotionalX6: this.policy.standardNotionalX6.toString(),
      yesTokenId: this.yesTokenId,
    };
  }

  #assertIdentity(raw: Record<string, unknown>): void {
    if (requiredString(raw.market, "market", 66).toLowerCase() !== this.conditionId.toLowerCase()) {
      throw new MarketDataError(
        "MAPPING_MISMATCH",
        "snapshot condition does not match subscription",
      );
    }
    if (requiredString(raw.asset_id, "asset_id", 128) !== this.yesTokenId) {
      throw new MarketDataError("MAPPING_MISMATCH", "snapshot asset does not match YES token");
    }
  }

  #remember(digest: Hex): void {
    this.#seen.add(digest);
    if (this.#seen.size > 1_024) {
      const oldest = this.#seen.values().next().value;
      if (oldest) this.#seen.delete(oldest);
    }
  }

  #replace(target: Map<bigint, bigint>, next: Array<[bigint, bigint]>): void {
    target.clear();
    for (const [price, size] of next) if (size > 0n) target.set(price, size);
  }

  #result(
    applied: boolean,
    duplicate: boolean,
    requiresSnapshot: boolean,
    nowMs: bigint,
  ): ApplyResult {
    return { applied, duplicate, requiresSnapshot, tick: applied ? this.tick(nowMs) : null };
  }
}
