import {
  formatPriceRawX18,
  formatTokenAmount,
  type MarketUnits,
  PRICE_FORMAT,
  PROTOCOL_VERSION,
  parsePriceRawX18,
  parseTokenAmount,
  quoteForExecution,
  quoteForReservation,
} from "@conditional-stocks/domain";
import type { SpotPrice, SpotPricesResponse } from "@conditional-stocks/shared/spot-prices";
import { marketTokenDisplay } from "@/lib/tokens/devnet";
import type {
  BookLevel,
  BranchBook,
  IndexedOrder,
  MarketLifecycle,
  MarketView,
  PositionView,
  ProbabilityView,
  ResolutionView,
  TradeView,
  WholeBalanceView,
} from "@/types/api";
import {
  CATALOGUE_EVENTS,
  CATALOGUE_MARKETS,
  type CatalogueEvent,
  type CatalogueMarket,
} from "./catalogue";
import {
  ACCOUNT_ADDRESS,
  CLAIM_ASSET,
  claimMintAddress,
  GENESIS_HASH,
  LIFECYCLE_OVERRIDES,
  MAX_TRADES_PER_MARKET,
  PROGRAM_ID,
  QUOTE_MINT,
  SPOT_ANCHORS,
  SPOT_REFERENCE_SYMBOLS,
  SPOT_SOURCE_MINTS,
  STARTING_WALLET_BALANCES,
  TICK_INTERVAL_MS,
  TRADING_DELEGATE,
} from "./config";
import { loadWalletState, type StoredWallet, saveWalletState } from "./persistence";
import { base58Id, createRandom, type Random, uniqueId } from "./random";

const LIFECYCLES: MarketLifecycle[] = [
  "scheduled",
  "open",
  "frozen",
  "awaiting-resolution",
  "resolved",
  "redeemable",
  "archived",
];

export interface BranchClaims {
  stockYes: bigint;
  stockNo: bigint;
  quoteYes: bigint;
  quoteNo: bigint;
}
type ClaimKey = keyof BranchClaims;

interface Level {
  priceTicks: number;
  qty: bigint;
}
interface Book {
  bids: Level[];
  asks: Level[];
}

interface MarketRuntime {
  meta: CatalogueMarket;
  event: CatalogueEvent;
  units: MarketUnits;
  lifecycle: MarketLifecycle;
  tickRaw: bigint;
  tickHuman: number;
  stepRaw: bigint;
  stepHuman: number;
  impact: [number, number];
  drift: [number, number];
  books: [Book, Book];
  trades: TradeView[];
  activity: number;
  random: Random;
}

interface PermissionState {
  granted: boolean;
  revoked: boolean;
  expiresAt: string;
  maxOrderQuote: bigint;
  totalQuote: bigint;
  remainingQuote: bigint;
}

interface WalletRuntime {
  connected: boolean;
  external: Map<string, bigint>;
  vault: Map<string, bigint>;
  claims: Map<string, BranchClaims>;
  externalClaims: Map<string, BranchClaims>;
  orders: IndexedOrder[];
  permission: PermissionState | null;
}

export interface OrderIntent {
  marketId: string;
  branch: "YES" | "NO";
  side: "buy" | "sell";
  tif: "gtc" | "ioc";
  funding: "whole" | "claim";
  quantityRaw: string;
  limitPriceRawX18: string;
  maxFeeBps: number;
}

export interface OrderPlan {
  deadline: string;
  filledQuantity: string;
  remainingQuery?: never;
  remainingQuantity: string;
  averagePriceRawX18: string;
  notional: string;
  requiredRaw: string;
  fundingMint: string;
  balanceSufficient: boolean;
}

const emptyClaims = (): BranchClaims => ({
  stockYes: 0n,
  stockNo: 0n,
  quoteYes: 0n,
  quoteNo: 0n,
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** 32-byte hex digest, stable for the same seed. */
function hexDigest(seed: string) {
  const random = createRandom(seed);
  let out = "0x";
  for (let index = 0; index < 64; index++) out += Math.floor(random.next() * 16).toString(16);
  return out;
}

// ---------------------------------------------------------------------------
// Market construction
// ---------------------------------------------------------------------------

const eventsByCondition = new Map(CATALOGUE_EVENTS.map((event) => [event.conditionId, event]));

function buildMarketRuntime(meta: CatalogueMarket): MarketRuntime {
  const event = eventsByCondition.get(meta.conditionId) as CatalogueEvent;
  const units: MarketUnits = {
    baseTokenDecimals: meta.baseTokenDecimals,
    quoteTokenDecimals: meta.quoteTokenDecimals,
    protocolVersion: PROTOCOL_VERSION,
    priceFormat: PRICE_FORMAT,
  };
  const tickRaw = BigInt(meta.priceTickRawX18);
  const stepRaw = BigInt(meta.baseStep);
  const random = createRandom(`market:${meta.id}`);
  const state = LIFECYCLE_OVERRIDES[meta.conditionId] ?? meta.state;
  // A YES branch usually prices above the NO branch when the event is bullish
  // for the asset; the split is stable per market so cards do not shuffle.
  const bias = (event.probability - 0.5) * 2;
  const magnitude = random.between(1.5, 7.5);
  const direction = random.chance(0.72) ? 1 : -1;
  const yesImpact = direction * magnitude * (0.45 + Math.abs(bias) * 0.55);
  const noImpact = -yesImpact * random.between(0.2, 0.55);
  return {
    meta,
    event,
    units,
    lifecycle: LIFECYCLES[Math.max(0, state - 1)] ?? "open",
    tickRaw,
    tickHuman: Number(formatPriceRawX18(tickRaw, units)),
    stepRaw,
    stepHuman: Number(formatTokenAmount(stepRaw, meta.baseTokenDecimals)),
    impact: [yesImpact, noImpact],
    drift: [0, 0],
    books: [
      { bids: [], asks: [] },
      { bids: [], asks: [] },
    ],
    trades: [],
    activity: random.between(0.25, 1),
    random,
  };
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

const markets = new Map<string, MarketRuntime>(
  CATALOGUE_MARKETS.map((meta) => [meta.id, buildMarketRuntime(meta)]),
);
const marketOrder = CATALOGUE_MARKETS.map((meta) => meta.id);

const spot = new Map<string, number>(Object.entries(SPOT_ANCHORS));
const spotRandom = createRandom("spot-feed");
const probabilities = new Map<string, number>(
  CATALOGUE_EVENTS.map((event) => [event.conditionId, event.probability]),
);
const probabilityRandom = createRandom("probability-feed");

let slot = 348_921_004;
let blockNumber = 348_921_004n;
// A wallet read reports the last block that touched that wallet, not the chain
// head, so an idle wallet keeps a stable snapshot between blocks.
let walletBlock = 348_921_004n;

const wallet: WalletRuntime = {
  connected: false,
  external: new Map(),
  vault: new Map(),
  claims: new Map(),
  externalClaims: new Map(),
  orders: [],
  permission: null,
};

const listeners = new Set<() => void>();
const probabilityListeners = new Map<string, Set<(value: ProbabilityView) => void>>();
let started = false;
let timer: ReturnType<typeof setInterval> | undefined;

function notify() {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeProbabilityFeed(
  conditionId: string,
  listener: (value: ProbabilityView) => void,
) {
  const group = probabilityListeners.get(conditionId) ?? new Set();
  group.add(listener);
  probabilityListeners.set(conditionId, group);
  start();
  listener(probabilityView(conditionId));
  return () => {
    group.delete(listener);
    if (!group.size) probabilityListeners.delete(conditionId);
  };
}

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

const priceRaw = (market: MarketRuntime, ticks: number) =>
  BigInt(Math.max(1, ticks)) * market.tickRaw;
const priceHuman = (market: MarketRuntime, ticks: number) =>
  Number(formatPriceRawX18(priceRaw(market, ticks), market.units));
const ticksFromHuman = (market: MarketRuntime, value: number) =>
  Math.max(1, Math.round(value / market.tickHuman));
const ticksFromRaw = (market: MarketRuntime, raw: bigint) => Number(raw / market.tickRaw);

const quantityRaw = (market: MarketRuntime, tokens: number) => {
  const steps = BigInt(Math.max(1, Math.round(tokens / market.stepHuman)));
  return steps * market.stepRaw;
};

function fairPrice(market: MarketRuntime, branch: 0 | 1) {
  const reference = spot.get(market.meta.baseToken) ?? 100;
  return reference * (1 + market.impact[branch] / 100) * (1 + market.drift[branch]);
}

function levelSize(market: MarketRuntime, depth: number, random: Random) {
  const reference = spot.get(market.meta.baseToken) ?? 100;
  // Keep quote-denominated depth in a believable band regardless of asset price.
  const notional = random.between(250, 4200) * (1 + depth * 0.22);
  return quantityRaw(market, notional / reference);
}

function seedBook(market: MarketRuntime, branch: 0 | 1) {
  const random = market.random;
  const mid = ticksFromHuman(market, fairPrice(market, branch));
  const half = random.int(1, 3);
  const book: Book = { bids: [], asks: [] };
  let ask = mid + half;
  let bid = Math.max(1, mid - half);
  for (let depth = 0; depth < 18; depth++) {
    book.asks.push({ priceTicks: ask, qty: levelSize(market, depth, random) });
    if (bid > 1) book.bids.push({ priceTicks: bid, qty: levelSize(market, depth, random) });
    ask += random.int(1, 3);
    bid = Math.max(1, bid - random.int(1, 3));
  }
  market.books[branch] = book;
}

function bookMidTicks(book: Book) {
  const bid = book.bids[0]?.priceTicks;
  const ask = book.asks[0]?.priceTicks;
  if (bid === undefined || ask === undefined) return null;
  return (bid + ask) / 2;
}

function shiftBook(market: MarketRuntime, branch: 0 | 1) {
  const book = market.books[branch];
  const current = bookMidTicks(book);
  const target = ticksFromHuman(market, fairPrice(market, branch));
  if (current === null) {
    seedBook(market, branch);
    return;
  }
  const delta = Math.round(target - current);
  if (delta === 0) return;
  // Move the whole ladder toward fair value one step at a time so the book
  // slides instead of teleporting.
  const move = Math.sign(delta) * Math.min(Math.abs(delta), 2);
  for (const level of [...book.bids, ...book.asks])
    level.priceTicks = Math.max(1, level.priceTicks + move);
}

function jitterBook(market: MarketRuntime, branch: 0 | 1) {
  const random = market.random;
  const book = market.books[branch];
  for (const side of [book.bids, book.asks]) {
    if (!side.length) continue;
    const changes = random.int(1, 3);
    for (let index = 0; index < changes; index++) {
      const level = side[random.int(0, side.length - 1)];
      if (!level) continue;
      const scaled = Number(level.qty) * random.between(0.55, 1.65);
      const steps = BigInt(Math.max(1, Math.round(scaled / Number(market.stepRaw))));
      level.qty = steps * market.stepRaw;
    }
    // Occasionally pull the front of the queue and refill the back.
    if (random.chance(0.16) && side.length > 6) {
      side.shift();
      const last = side[side.length - 1];
      const outward = side === book.asks ? 1 : -1;
      if (last)
        side.push({
          priceTicks: Math.max(1, last.priceTicks + outward * random.int(1, 3)),
          qty: levelSize(market, side.length, random),
        });
    }
    if (random.chance(0.14)) {
      const first = side[0];
      const inward = side === book.asks ? -1 : 1;
      if (first && side.length < 22) {
        const priceTicks = Math.max(1, first.priceTicks + inward * random.int(1, 2));
        const opposite = side === book.asks ? book.bids[0]?.priceTicks : book.asks[0]?.priceTicks;
        const crosses =
          opposite !== undefined &&
          (side === book.asks ? priceTicks <= opposite : priceTicks >= opposite);
        if (!crosses) side.unshift({ priceTicks, qty: levelSize(market, 0, random) });
      }
    }
  }
  book.bids.sort((a, b) => b.priceTicks - a.priceTicks);
  book.asks.sort((a, b) => a.priceTicks - b.priceTicks);
}

// ---------------------------------------------------------------------------
// Trade tape
// ---------------------------------------------------------------------------

function recordTrade(
  market: MarketRuntime,
  branch: 0 | 1,
  priceTicks: number,
  qty: bigint,
  at: number,
  hashes: { maker?: string; taker?: string; buy?: string; sell?: string } = {},
) {
  const transactionHash = uniqueId(`tx:${market.meta.id}:${at}`, 88);
  const raw = priceRaw(market, priceTicks);
  const trade: TradeView = {
    branch,
    blockTimestamp: String(at),
    executionPriceRawX18: raw.toString(),
    executionQuote: quoteForExecution(qty, raw).toString(),
    fillQuantity: qty.toString(),
    id: `${transactionHash}:${market.trades.length}`,
    marketId: market.meta.id,
    transactionHash,
    confirmation: "finalized",
    ...(hashes.maker ? { makerOrderHash: hashes.maker } : {}),
    ...(hashes.taker ? { takerOrderHash: hashes.taker } : {}),
    ...(hashes.buy ? { buyOrderHash: hashes.buy } : {}),
    ...(hashes.sell ? { sellOrderHash: hashes.sell } : {}),
  };
  market.trades.push(trade);
  if (market.trades.length > MAX_TRADES_PER_MARKET)
    market.trades.splice(0, market.trades.length - MAX_TRADES_PER_MARKET);
  return trade;
}

/** Backfill a week of fills so the price chart has history on first paint. */
function seedHistory(market: MarketRuntime) {
  const random = createRandom(`history:${market.meta.id}`);
  const end = nowSeconds();
  const start = end - 7 * 86_400;
  const points = 150;
  const walk: [number, number] = [0, 0];
  for (let index = 0; index < points; index++) {
    const at = Math.floor(start + ((end - start) * index) / points + random.between(0, 400));
    const branch: 0 | 1 = random.chance(0.55) ? 0 : 1;
    walk[branch] += random.normal() * 0.004;
    walk[branch] = Math.max(-0.09, Math.min(0.09, walk[branch]));
    const reference = SPOT_ANCHORS[market.meta.baseToken] ?? 100;
    const price = reference * (1 + market.impact[branch] / 100) * (1 + walk[branch]);
    const qty = quantityRaw(market, random.between(200, 2500) / reference);
    recordTrade(market, branch, ticksFromHuman(market, price), qty, at, {
      maker: base58Id(`maker:${market.meta.id}:${index}`),
      taker: base58Id(`taker:${market.meta.id}:${index}`),
    });
  }
  market.trades.sort((a, b) => Number(a.blockTimestamp) - Number(b.blockTimestamp));
}

function marketTick(market: MarketRuntime) {
  if (market.lifecycle !== "open") return;
  const random = market.random;
  for (const branch of [0, 1] as const) {
    market.drift[branch] += random.normal() * 0.0007;
    market.drift[branch] = Math.max(-0.05, Math.min(0.05, market.drift[branch]));
    shiftBook(market, branch);
    jitterBook(market, branch);
  }
  if (random.chance(0.22 * market.activity)) {
    const branch: 0 | 1 = random.chance(0.55) ? 0 : 1;
    const book = market.books[branch];
    const buy = random.chance(0.5);
    const level = buy ? book.asks[0] : book.bids[0];
    if (level) {
      const take =
        level.qty > market.stepRaw * 4n ? level.qty / BigInt(random.int(2, 6)) : level.qty;
      const steps = take / market.stepRaw;
      const qty = (steps > 0n ? steps : 1n) * market.stepRaw;
      level.qty -= qty;
      if (level.qty <= 0n) (buy ? book.asks : book.bids).shift();
      recordTrade(market, branch, level.priceTicks, qty, nowSeconds(), {
        maker: base58Id(`maker:${market.meta.id}:${slot}`),
        taker: base58Id(`taker:${market.meta.id}:${slot}`),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

function tick() {
  slot += 2;
  blockNumber += 2n;
  for (const [mint, anchor] of Object.entries(SPOT_ANCHORS)) {
    const current = spot.get(mint) ?? anchor;
    const drift = mint === QUOTE_MINT ? 0.00002 : 0.0006;
    const next = current * (1 + spotRandom.normal() * drift);
    spot.set(mint, Math.max(anchor * 0.9, Math.min(anchor * 1.1, next)));
  }
  for (const [conditionId, value] of probabilities) {
    const next = value + probabilityRandom.normal() * 0.0025;
    probabilities.set(conditionId, Math.max(0.01, Math.min(0.99, next)));
  }
  for (const market of markets.values()) marketTick(market);
  fillRestingOrders();
  notify();
  for (const [conditionId, group] of probabilityListeners) {
    const view = probabilityView(conditionId);
    for (const listener of group) listener(view);
  }
}

export function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  restore();
  for (const market of markets.values()) {
    seedHistory(market);
    seedBook(market, 0);
    seedBook(market, 1);
  }
  timer = setInterval(tick, TICK_INTERVAL_MS);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
  started = false;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function branchBook(market: MarketRuntime, branch: 0 | 1): BranchBook {
  const source = market.books[branch];
  const resting = wallet.orders.filter(
    (order) =>
      order.status === "open" && order.marketId === market.meta.id && order.branch === branch,
  );
  const merge = (levels: Level[], side: 0 | 1): BookLevel[] => {
    const totals = new Map<number, bigint>();
    for (const level of levels)
      if (level.qty > 0n)
        totals.set(level.priceTicks, (totals.get(level.priceTicks) ?? 0n) + level.qty);
    for (const order of resting) {
      if (order.side !== side) continue;
      const ticks = ticksFromRaw(market, BigInt(order.limitPriceRawX18));
      totals.set(ticks, (totals.get(ticks) ?? 0n) + BigInt(order.remaining));
    }
    return [...totals]
      .sort(([a], [b]) => (side === 0 ? b - a : a - b))
      .map(([ticks, qty]) => ({
        priceExact: formatPriceRawX18(priceRaw(market, ticks), market.units),
        price: priceHuman(market, ticks),
        quantity: Number(formatTokenAmount(qty, market.meta.baseTokenDecimals)),
      }));
  };
  const bids = merge(source.bids, 0);
  const asks = merge(source.asks, 1);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    asks,
    bids,
    bestAskExact: asks[0]?.priceExact ?? null,
    bestBidExact: bids[0]?.priceExact ?? null,
    bestAsk,
    bestBid,
    depthUsd: [...bids, ...asks].reduce((total, level) => total + level.price * level.quantity, 0),
    spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
  };
}

function probabilityView(conditionId: string): ProbabilityView {
  const value = probabilities.get(conditionId) ?? null;
  if (value === null)
    return { ask: null, bid: null, observedAt: null, quality: "disconnected", value: null };
  const spread = 0.01;
  return {
    ask: Math.min(0.999, value + spread / 2),
    bid: Math.max(0.001, value - spread / 2),
    observedAt: new Date().toISOString(),
    quality: "valid",
    value,
  };
}

function marketView(market: MarketRuntime): MarketView {
  const { meta, event } = market;
  const yes = branchBook(market, 0);
  const no = branchBook(market, 1);
  const yesMid =
    yes.bestBid !== null && yes.bestAsk !== null ? (yes.bestBid + yes.bestAsk) / 2 : null;
  const noMid = no.bestBid !== null && no.bestAsk !== null ? (no.bestBid + no.bestAsk) / 2 : null;
  return {
    baseTokenDecimals: meta.baseTokenDecimals,
    quoteTokenDecimals: meta.quoteTokenDecimals,
    protocolVersion: PROTOCOL_VERSION,
    priceFormat: PRICE_FORMAT,
    baseStep: meta.baseStep,
    priceTickRawX18: meta.priceTickRawX18,
    bookQuality: "available",
    baseToken: meta.baseToken,
    cutoff: new Date(Number(meta.tradingCutoff) * 1000).toISOString(),
    createdAt: meta.createdAt,
    description: event.rules,
    eventImpact: yesMid !== null && noMid !== null ? yesMid - noMid : null,
    id: meta.id,
    lifecycle: market.lifecycle,
    mapping: {
      conditionId: meta.conditionId,
      noIndex: meta.noIndex,
      polymarketUrl: event.canonicalUrl,
      yesIndex: meta.yesIndex,
    },
    no,
    ordinaryReference: null,
    probability: probabilityView(meta.conditionId),
    question: event.question,
    imageUrl: event.imageUrl,
    quoteToken: meta.quoteToken,
    residual: null,
    ...marketTokenDisplay(meta.baseToken, meta.quoteToken, GENESIS_HASH, meta.ticker),
    tradingOpen: new Date(Number(meta.tradingOpen) * 1000).toISOString(),
    yes,
  };
}

export function listMarkets(marketId?: string): MarketView[] {
  if (marketId) {
    const market = markets.get(marketId);
    return market ? [marketView(market)] : [];
  }
  return marketOrder.flatMap((id) => {
    const market = markets.get(id);
    return market ? [marketView(market)] : [];
  });
}

export function listTrades(marketId?: string): TradeView[] {
  if (marketId) {
    const market = markets.get(marketId);
    return market ? [...market.trades].reverse().slice(0, 100) : [];
  }
  return [...markets.values()]
    .flatMap((market) => market.trades)
    .sort((a, b) => Number(b.blockTimestamp) - Number(a.blockTimestamp))
    .slice(0, 1000);
}

export function readiness(marketId: string) {
  const market = markets.get(marketId);
  const checkedAt = Date.now();
  if (!market) return { healthy: false, reason: "unavailable", checkedAt };
  const now = nowSeconds();
  if (market.lifecycle === "scheduled" || now < Number(market.meta.tradingOpen))
    return { healthy: false, reason: "scheduled", checkedAt };
  if (market.lifecycle !== "open" || now >= Number(market.meta.tradingCutoff))
    return { healthy: false, reason: "closed", checkedAt };
  return { healthy: true, reason: "ready", checkedAt };
}

export function resolution(marketId: string): ResolutionView | null {
  const market = markets.get(marketId);
  if (!market || !["resolved", "redeemable", "archived"].includes(market.lifecycle)) return null;
  return {
    admin: base58Id(`admin:${market.meta.conditionId}`),
    evidenceHash: hexDigest(`evidence:${market.meta.id}`),
    evidenceUri: market.event.canonicalUrl,
    noPayout: "0",
    payoutDenominator: "1",
    transactionHash: base58Id(`resolve:${market.meta.id}`, 88),
    yesPayout: "1",
  };
}

export function spotPrices(mints: string[]): SpotPricesResponse {
  const asOf = nowSeconds();
  const prices: SpotPrice[] = mints.map((mint) => {
    const value = spot.get(mint);
    const sourceMint = SPOT_SOURCE_MINTS[mint] ?? null;
    if (value === undefined || sourceMint === null)
      return {
        mint,
        sourceMint: null,
        referenceSymbol: null,
        testAsset: false,
        valuationCompatible: false,
        status: "unmapped",
        priceUsd: null,
        sourceDecimals: null,
        blockId: null,
        priceTimestamp: null,
        fetchedAt: null,
      };
    return {
      mint,
      sourceMint,
      referenceSymbol: SPOT_REFERENCE_SYMBOLS[mint] ?? null,
      testAsset: false,
      valuationCompatible: true,
      status: "available",
      priceUsd: value,
      sourceDecimals: mint === QUOTE_MINT ? 6 : 8,
      blockId: 449_132_647 + slot,
      priceTimestamp: asOf - 1,
      fetchedAt: asOf,
    };
  });
  return {
    source: "jupiter",
    sourceGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    displayOnly: true,
    genesisHash: GENESIS_HASH,
    asOf,
    prices,
  };
}

export function probabilitySnapshot(conditionId: string) {
  return probabilityView(conditionId);
}

// ---------------------------------------------------------------------------
// Wallet projections
// ---------------------------------------------------------------------------

const claimKeyFor = (side: 0 | 1, branch: 0 | 1): ClaimKey =>
  side === 0 ? (branch === 0 ? "quoteYes" : "quoteNo") : branch === 0 ? "stockYes" : "stockNo";

const claimAssetIndex: Record<ClaimKey, number> = {
  stockYes: CLAIM_ASSET.stockYes,
  stockNo: CLAIM_ASSET.stockNo,
  quoteYes: CLAIM_ASSET.quoteYes,
  quoteNo: CLAIM_ASSET.quoteNo,
};

const claimsFor = (marketId: string) => {
  const existing = wallet.claims.get(marketId);
  if (existing) return existing;
  const created = emptyClaims();
  wallet.claims.set(marketId, created);
  return created;
};

const externalClaimsFor = (marketId: string) => {
  const existing = wallet.externalClaims.get(marketId);
  if (existing) return existing;
  const created = emptyClaims();
  wallet.externalClaims.set(marketId, created);
  return created;
};

/** Whole-token amounts locked by resting orders funded from the vault. */
function reservedWhole(mint: string) {
  let total = 0n;
  for (const order of wallet.orders) {
    if (order.status !== "open" || order.fundingKind !== 0) continue;
    const market = markets.get(order.marketId);
    if (!market) continue;
    const fundingMint = order.side === 0 ? market.meta.quoteToken : market.meta.baseToken;
    if (fundingMint === mint) total += BigInt(order.reserved);
  }
  return total;
}

function decimalsForMint(mint: string) {
  for (const market of markets.values()) {
    if (market.meta.baseToken === mint) return market.meta.baseTokenDecimals;
    if (market.meta.quoteToken === mint) return market.meta.quoteTokenDecimals;
  }
  return 6;
}

export interface WalletSnapshot {
  owner: string;
  observedAt: number;
  blockNumber: string;
  positions: PositionView[];
  balances: Record<string, WholeBalanceView>;
}

export function walletSnapshot(): WalletSnapshot {
  const balances: Record<string, WholeBalanceView> = {};
  const catalogue = [...markets.values()];
  const mints = new Set<string>([
    ...wallet.external.keys(),
    ...wallet.vault.keys(),
    ...catalogue.map((market) => market.meta.baseToken),
    ...catalogue.map((market) => market.meta.quoteToken),
  ]);
  for (const mint of mints) {
    const decimals = decimalsForMint(mint);
    balances[mint] = {
      account: ACCOUNT_ADDRESS,
      token: mint,
      decimals,
      blockNumber: walletBlock.toString(),
      canonicalBalance: (wallet.external.get(mint) ?? 0n).toString(),
      vaultAvailable: (wallet.vault.get(mint) ?? 0n).toString(),
      reserved: reservedWhole(mint).toString(),
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      creditBalances: {},
    };
  }
  // Claim balances live on their own mints, keyed by the market that issued them.
  for (const [marketId, claims] of wallet.claims) {
    const external = wallet.externalClaims.get(marketId) ?? emptyClaims();
    const market = markets.get(marketId);
    if (!market) continue;
    for (const key of Object.keys(claimAssetIndex) as ClaimKey[]) {
      const asset = claimAssetIndex[key];
      const mint = claimMintAddress(marketId, asset);
      balances[mint] = {
        account: ACCOUNT_ADDRESS,
        token: mint,
        decimals:
          key === "stockYes" || key === "stockNo"
            ? market.meta.baseTokenDecimals
            : market.meta.quoteTokenDecimals,
        blockNumber: walletBlock.toString(),
        canonicalBalance: external[key].toString(),
        vaultAvailable: "0",
        reserved: "0",
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        creditBalances: { [marketId]: claims[key].toString() },
      };
    }
  }
  const positions: PositionView[] = [...wallet.claims].flatMap(([marketId, claims]) => {
    const market = markets.get(marketId);
    if (!market) return [];
    return [
      {
        conditionId: marketId,
        marketId,
        baseTokenDecimals: market.meta.baseTokenDecimals,
        quoteTokenDecimals: market.meta.quoteTokenDecimals,
        protocolVersion: PROTOCOL_VERSION,
        priceFormat: PRICE_FORMAT,
        quoteNo: claims.quoteNo.toString(),
        quoteYes: claims.quoteYes.toString(),
        redeemable: market.lifecycle === "redeemable" || market.lifecycle === "archived",
        stockNo: claims.stockNo.toString(),
        stockYes: claims.stockYes.toString(),
      },
    ];
  });
  return {
    owner: ACCOUNT_ADDRESS,
    observedAt: Date.now(),
    blockNumber: walletBlock.toString(),
    positions,
    balances,
  };
}

export function listOrders() {
  return {
    orders: [...wallet.orders].sort((a, b) => Number(b.updatedBlock) - Number(a.updatedBlock)),
    truncated: false,
    openTruncated: false,
  };
}

export function payouts() {
  return { vault: PROGRAM_ID, payouts: [], nextCursor: null };
}

export interface ProtocolPermission {
  owner: string;
  available: boolean;
  delegate: string | null;
  active: boolean;
  slot: string;
  quoteMint: string;
  quoteDecimals: number | null;
  grant: null | {
    market: string;
    expiresAt: string;
    maxOrderQuote: string;
    remainingQuote: string;
    maxFeeBps: number;
    permissions: number;
    revoked: boolean;
  };
}

export function permission(): ProtocolPermission {
  const state = wallet.permission;
  const expired = state ? Number(state.expiresAt) * 1000 <= Date.now() : false;
  const active = Boolean(state?.granted && !state.revoked && !expired && state.remainingQuote > 0n);
  return {
    owner: ACCOUNT_ADDRESS,
    available: true,
    delegate: TRADING_DELEGATE,
    active,
    slot: String(slot),
    quoteMint: QUOTE_MINT,
    quoteDecimals: 6,
    grant: state
      ? {
          market: "11111111111111111111111111111111",
          expiresAt: state.expiresAt,
          maxOrderQuote: state.maxOrderQuote.toString(),
          remainingQuote: state.remainingQuote.toString(),
          maxFeeBps: 100,
          permissions: 1,
          revoked: state.revoked,
        }
      : null,
  };
}

export const isConnected = () => wallet.connected;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function connect() {
  if (!wallet.connected) {
    wallet.connected = true;
    if (wallet.external.size === 0)
      for (const [mint, amount] of Object.entries(STARTING_WALLET_BALANCES))
        wallet.external.set(mint, parseTokenAmount(String(amount), decimalsForMint(mint)));
    persist();
  }
  start();
  notify();
  return ACCOUNT_ADDRESS;
}

export function disconnect() {
  wallet.connected = false;
  persist();
  notify();
}

/** Clears every trace of the session, including saved balances and orders. */
export function resetWallet() {
  wallet.connected = false;
  wallet.external.clear();
  wallet.vault.clear();
  wallet.claims.clear();
  wallet.externalClaims.clear();
  wallet.orders = [];
  wallet.permission = null;
  persist();
  notify();
}

export function deposit(mint: string, amountRaw: bigint) {
  const available = wallet.external.get(mint) ?? 0n;
  if (amountRaw <= 0n) throw new Error("Enter a positive token amount");
  if (amountRaw > available) throw new Error("Deposit exceeds the external wallet balance");
  wallet.external.set(mint, available - amountRaw);
  wallet.vault.set(mint, (wallet.vault.get(mint) ?? 0n) + amountRaw);
  return settle(`deposit:${mint}`);
}

export function withdraw(mint: string, amountRaw: bigint) {
  const available = wallet.vault.get(mint) ?? 0n;
  if (amountRaw <= 0n) throw new Error("Enter a positive token amount");
  if (amountRaw > available) throw new Error("Insufficient available vault balance");
  wallet.vault.set(mint, available - amountRaw);
  wallet.external.set(mint, (wallet.external.get(mint) ?? 0n) + amountRaw);
  return settle(`withdraw:${mint}`);
}

export function approveTrading(perOrder: string, total: string) {
  const maxOrderQuote = parseTokenAmount(perOrder.trim(), 6);
  const totalQuote = parseTokenAmount(total.trim(), 6);
  if (maxOrderQuote <= 0n || totalQuote < maxOrderQuote)
    throw new Error("Set a positive per-order limit and a larger lifetime limit");
  wallet.permission = {
    granted: true,
    revoked: false,
    expiresAt: String(nowSeconds() + 90 * 86_400),
    maxOrderQuote,
    totalQuote,
    remainingQuote: totalQuote,
  };
  return settle("permission:approve");
}

export function revokeTrading() {
  if (!wallet.permission) throw new Error("No active trading permission to revoke");
  wallet.permission.revoked = true;
  return settle("permission:revoke");
}

function settle(seed: string) {
  persist();
  notify();
  return uniqueId(`sig:${seed}`, 88);
}

// --- order flow -------------------------------------------------------------

interface Fill {
  priceTicks: number;
  qty: bigint;
}

/** Walk the resting side of the book and collect the fills a taker would get. */
function planFills(market: MarketRuntime, intent: OrderIntent, mutate: boolean): Fill[] {
  const branch = intent.branch === "YES" ? 0 : 1;
  const book = market.books[branch];
  const side = intent.side === "buy" ? book.asks : book.bids;
  const limit = ticksFromRaw(market, BigInt(intent.limitPriceRawX18));
  let remaining = BigInt(intent.quantityRaw);
  const fills: Fill[] = [];
  for (const level of side) {
    if (remaining <= 0n) break;
    const acceptable =
      intent.side === "buy" ? level.priceTicks <= limit : level.priceTicks >= limit;
    if (!acceptable) break;
    const take = level.qty < remaining ? level.qty : remaining;
    if (take <= 0n) continue;
    fills.push({ priceTicks: level.priceTicks, qty: take });
    remaining -= take;
    if (mutate) level.qty -= take;
  }
  if (mutate) {
    book.asks = book.asks.filter((level) => level.qty > 0n);
    book.bids = book.bids.filter((level) => level.qty > 0n);
  }
  return fills;
}

function fundingMintFor(market: MarketRuntime, intent: OrderIntent) {
  if (intent.funding === "whole")
    return intent.side === "buy" ? market.meta.quoteToken : market.meta.baseToken;
  const branch = intent.branch === "YES" ? 0 : 1;
  return claimMintAddress(
    market.meta.id,
    claimAssetIndex[claimKeyFor(intent.side === "buy" ? 0 : 1, branch)],
  );
}

function requiredReserve(intent: OrderIntent) {
  const qty = BigInt(intent.quantityRaw);
  return intent.side === "buy" ? quoteForReservation(qty, BigInt(intent.limitPriceRawX18)) : qty;
}

function availableFunding(market: MarketRuntime, intent: OrderIntent) {
  if (intent.funding === "whole")
    return (
      wallet.vault.get(intent.side === "buy" ? market.meta.quoteToken : market.meta.baseToken) ?? 0n
    );
  const branch = intent.branch === "YES" ? 0 : 1;
  return claimsFor(market.meta.id)[claimKeyFor(intent.side === "buy" ? 0 : 1, branch)];
}

export function reviewOrder(intent: OrderIntent): OrderPlan {
  const market = markets.get(intent.marketId);
  if (!market) throw new Error("Market is not indexed");
  const fills = planFills(market, intent, false);
  const filled = fills.reduce((total, fill) => total + fill.qty, 0n);
  const quantity = BigInt(intent.quantityRaw);
  const notional = fills.reduce(
    (total, fill) => total + quoteForExecution(fill.qty, priceRaw(market, fill.priceTicks)),
    0n,
  );
  const required = requiredReserve(intent);
  return {
    deadline: String(nowSeconds() + 45),
    filledQuantity: filled.toString(),
    remainingQuantity: (quantity - filled).toString(),
    averagePriceRawX18:
      filled > 0n ? ((notional * 10n ** 18n) / filled).toString() : intent.limitPriceRawX18,
    notional: notional.toString(),
    requiredRaw: required.toString(),
    fundingMint: fundingMintFor(market, intent),
    balanceSufficient: availableFunding(market, intent) >= required,
  };
}

function takeFunding(market: MarketRuntime, intent: OrderIntent, amount: bigint) {
  if (intent.funding === "whole") {
    const mint = intent.side === "buy" ? market.meta.quoteToken : market.meta.baseToken;
    const available = wallet.vault.get(mint) ?? 0n;
    if (available < amount) throw new Error("Deposit the required balance in Portfolio");
    wallet.vault.set(mint, available - amount);
    return;
  }
  const branch = intent.branch === "YES" ? 0 : 1;
  const key = claimKeyFor(intent.side === "buy" ? 0 : 1, branch);
  const claims = claimsFor(market.meta.id);
  if (claims[key] < amount) throw new Error("Not enough active claims to fund this order");
  claims[key] -= amount;
}

function returnFunding(market: MarketRuntime, order: IndexedOrder, amount: bigint) {
  if (amount <= 0n) return;
  if (order.fundingKind === 0) {
    const mint = order.side === 0 ? market.meta.quoteToken : market.meta.baseToken;
    wallet.vault.set(mint, (wallet.vault.get(mint) ?? 0n) + amount);
    return;
  }
  const key = claimKeyFor(order.side as 0 | 1, order.branch as 0 | 1);
  claimsFor(market.meta.id)[key] += amount;
}

/** Credit the claims a settled fill produces, matching the protocol's funding rules. */
function creditFill(market: MarketRuntime, order: IndexedOrder, qty: bigint, quote: bigint) {
  const claims = claimsFor(market.meta.id);
  const yes = order.branch === 0;
  if (order.side === 0) {
    claims[yes ? "stockYes" : "stockNo"] += qty;
    if (order.fundingKind === 0) claims[yes ? "quoteNo" : "quoteYes"] += quote;
  } else {
    claims[yes ? "quoteYes" : "quoteNo"] += quote;
    if (order.fundingKind === 0) claims[yes ? "stockNo" : "stockYes"] += qty;
  }
}

function applyFills(market: MarketRuntime, order: IndexedOrder, fills: Fill[]) {
  for (const fill of fills) {
    const raw = priceRaw(market, fill.priceTicks);
    const quote = quoteForExecution(fill.qty, raw);
    const consumed = order.side === 0 ? quoteForReservation(fill.qty, raw) : fill.qty;
    const reserved = BigInt(order.reserved);
    order.reserved = (reserved > consumed ? reserved - consumed : 0n).toString();
    order.filled = (BigInt(order.filled) + fill.qty).toString();
    order.remaining = (BigInt(order.remaining) - fill.qty).toString();
    creditFill(market, order, fill.qty, quote);
    recordTrade(market, order.branch as 0 | 1, fill.priceTicks, fill.qty, nowSeconds(), {
      taker: order.id,
      maker: base58Id(`maker:${order.id}:${fill.priceTicks}`),
      ...(order.side === 0 ? { buy: order.id } : { sell: order.id }),
    });
  }
}

export function submitOrder(intent: OrderIntent) {
  const market = markets.get(intent.marketId);
  if (!market) throw new Error("Market is not indexed");
  if (market.lifecycle !== "open") throw new Error("Trading has closed for this market.");
  const current = permission();
  if (!current.active) throw new Error("Enable trading before placing an order.");
  const required = requiredReserve(intent);
  const quantity = BigInt(intent.quantityRaw);
  const limit = BigInt(intent.limitPriceRawX18);
  const notionalCap = quoteForReservation(quantity, limit);
  if (wallet.permission && notionalCap > wallet.permission.maxOrderQuote)
    throw new Error("Order exceeds the approved per-order limit");
  if (wallet.permission && notionalCap > wallet.permission.remainingQuote)
    throw new Error("Order exceeds the remaining lifetime trading limit");
  takeFunding(market, intent, required);
  const orderHash = uniqueId(`order:${market.meta.id}`, 44);
  const order: IndexedOrder = {
    branch: intent.branch === "YES" ? 0 : 1,
    confirmation: "finalized",
    expiry: String(Math.min(nowSeconds() + 30 * 86_400, Number(market.meta.tradingCutoff) - 1)),
    feesPaid: "0",
    filled: "0",
    fundingKind: intent.funding === "whole" ? 0 : 1,
    id: orderHash,
    limitPriceRawX18: intent.limitPriceRawX18,
    maker: ACCOUNT_ADDRESS,
    marketId: market.meta.id,
    maxFeeBps: intent.maxFeeBps,
    quantity: quantity.toString(),
    remaining: quantity.toString(),
    reserved: required.toString(),
    side: intent.side === "buy" ? 0 : 1,
    status: "open",
    tif: intent.tif === "gtc" ? 0 : 1,
    updatedBlock: blockNumber.toString(),
  };
  const fills = planFills(market, intent, true);
  applyFills(market, order, fills);
  if (wallet.permission) {
    const spent =
      notionalCap < wallet.permission.remainingQuote
        ? notionalCap
        : wallet.permission.remainingQuote;
    wallet.permission.remainingQuote -= spent;
  }
  // Filling inside the signed limit leaves unused escrow; release it with the order.
  if (BigInt(order.remaining) === 0n) {
    returnFunding(market, order, BigInt(order.reserved));
    order.reserved = "0";
    order.status = "filled";
  } else if (intent.tif === "ioc") {
    returnFunding(market, order, BigInt(order.reserved));
    order.reserved = "0";
    order.status = BigInt(order.filled) > 0n ? "filled" : "closed";
  }
  wallet.orders.unshift(order);
  persist();
  notify();
  return { signature: uniqueId(`sig:${orderHash}`, 88), orderHash };
}

export function cancelOrder(orderHash: string) {
  const order = wallet.orders.find((row) => row.id === orderHash);
  if (!order) throw new Error("Order is not open");
  if (order.status !== "open") throw new Error("Order is no longer open");
  const market = markets.get(order.marketId);
  if (market) returnFunding(market, order, BigInt(order.reserved));
  order.reserved = "0";
  order.status = nowSeconds() >= Number(order.expiry) ? "expired" : "cancelled";
  order.updatedBlock = blockNumber.toString();
  return settle(`cancel:${orderHash}`);
}

/** Resting orders fill as the simulated book trades through their limit. */
function fillRestingOrders() {
  for (const order of wallet.orders) {
    if (order.status !== "open") continue;
    const market = markets.get(order.marketId);
    if (market?.lifecycle !== "open") continue;
    if (nowSeconds() >= Number(order.expiry)) {
      returnFunding(market, order, BigInt(order.reserved));
      order.reserved = "0";
      order.status = "expired";
      order.updatedBlock = blockNumber.toString();
      continue;
    }
    const book = market.books[order.branch as 0 | 1];
    const best = order.side === 0 ? book.asks[0]?.priceTicks : book.bids[0]?.priceTicks;
    if (best === undefined) continue;
    const limit = ticksFromRaw(market, BigInt(order.limitPriceRawX18));
    const crossed = order.side === 0 ? best <= limit : best >= limit;
    if (!crossed || !market.random.chance(0.45)) continue;
    const remaining = BigInt(order.remaining);
    const slice = remaining / BigInt(market.random.int(1, 4));
    const steps = (slice > 0n ? slice : remaining) / market.stepRaw;
    const qty = steps > 0n ? steps * market.stepRaw : remaining;
    const fill = qty > remaining ? remaining : qty;
    if (fill <= 0n) continue;
    applyFills(market, order, [{ priceTicks: limit, qty: fill }]);
    order.updatedBlock = blockNumber.toString();
    if (BigInt(order.remaining) === 0n) {
      returnFunding(market, order, BigInt(order.reserved));
      order.reserved = "0";
      order.status = "filled";
    }
    persist();
  }
}

// --- claim management -------------------------------------------------------

export type ClaimActionKind = "Deposit" | "Split" | "Merge" | "Redeem";

export interface RecoveryPreview {
  merge: bigint;
  redeemYes: bigint;
  redeemNo: bigint;
  credit: bigint;
  burnYes: bigint;
  burnNo: bigint;
  retainedYes: bigint;
  retainedNo: bigint;
}

export function redemptionPreview(yesAmount: bigint, noAmount: bigint): RecoveryPreview {
  const merge = yesAmount < noAmount ? yesAmount : noAmount;
  const redeemYes = yesAmount - merge;
  const redeemNo = noAmount - merge;
  // Settled YES: complete pairs recover collateral, excess YES pays in full,
  // excess NO is worthless and burns for zero.
  const credit = merge + redeemYes;
  return {
    merge,
    redeemYes,
    redeemNo,
    credit,
    burnYes: yesAmount,
    burnNo: noAmount,
    retainedYes: 0n,
    retainedNo: 0n,
  };
}

export function claimAction(input: {
  kind: ClaimActionKind;
  marketId: string;
  collateral: "Stock" | "Cash";
  branch: "All" | "YES" | "NO";
  amount: bigint;
}) {
  const market = markets.get(input.marketId);
  if (!market) throw new Error("Market is not indexed");
  const stock = input.collateral === "Stock";
  const mint = stock ? market.meta.baseToken : market.meta.quoteToken;
  const claims = claimsFor(input.marketId);
  const yesKey: ClaimKey = stock ? "stockYes" : "quoteYes";
  const noKey: ClaimKey = stock ? "stockNo" : "quoteNo";
  if (input.kind === "Split") {
    const available = wallet.vault.get(mint) ?? 0n;
    if (input.amount <= 0n || input.amount > available)
      throw new Error("Split amount exceeds the deposited vault balance");
    wallet.vault.set(mint, available - input.amount);
    claims[yesKey] += input.amount;
    claims[noKey] += input.amount;
  } else if (input.kind === "Merge") {
    const pairs = claims[yesKey] < claims[noKey] ? claims[yesKey] : claims[noKey];
    if (input.amount <= 0n || input.amount > pairs)
      throw new Error("Merge requires an equal YES and NO claim pair");
    claims[yesKey] -= input.amount;
    claims[noKey] -= input.amount;
    wallet.vault.set(mint, (wallet.vault.get(mint) ?? 0n) + input.amount);
  } else if (input.kind === "Deposit") {
    const key = input.branch === "NO" ? noKey : yesKey;
    const external = externalClaimsFor(input.marketId);
    if (input.amount <= 0n || input.amount > external[key])
      throw new Error("Deposit exceeds the external claim balance");
    external[key] -= input.amount;
    claims[key] += input.amount;
  } else {
    if (market.lifecycle !== "redeemable" && market.lifecycle !== "archived")
      throw new Error("Redemption is not enabled for this market");
    const yesAmount =
      input.branch === "NO" ? 0n : input.branch === "All" ? claims[yesKey] : input.amount;
    const noAmount =
      input.branch === "YES" ? 0n : input.branch === "All" ? claims[noKey] : input.amount;
    if (yesAmount > claims[yesKey] || noAmount > claims[noKey])
      throw new Error("Redemption exceeds the available claims");
    const preview = redemptionPreview(yesAmount, noAmount);
    claims[yesKey] -= yesAmount;
    claims[noKey] -= noAmount;
    wallet.vault.set(mint, (wallet.vault.get(mint) ?? 0n) + preview.credit);
  }
  return settle(`claim:${input.kind}:${input.marketId}`);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const toRecord = (map: Map<string, bigint>) =>
  Object.fromEntries([...map].map(([key, value]) => [key, value.toString()]));
const claimsRecord = (map: Map<string, BranchClaims>) =>
  Object.fromEntries(
    [...map].map(([key, value]) => [
      key,
      {
        stockYes: value.stockYes.toString(),
        stockNo: value.stockNo.toString(),
        quoteYes: value.quoteYes.toString(),
        quoteNo: value.quoteNo.toString(),
      },
    ]),
  );

function persist() {
  walletBlock = blockNumber;
  saveWalletState({
    connected: wallet.connected,
    external: toRecord(wallet.external),
    vault: toRecord(wallet.vault),
    claims: claimsRecord(wallet.claims),
    externalClaims: claimsRecord(wallet.externalClaims),
    orders: wallet.orders,
    permission: wallet.permission
      ? {
          granted: wallet.permission.granted,
          revoked: wallet.permission.revoked,
          expiresAt: wallet.permission.expiresAt,
          maxOrderQuote: wallet.permission.maxOrderQuote.toString(),
          totalQuote: wallet.permission.totalQuote.toString(),
          remainingQuote: wallet.permission.remainingQuote.toString(),
        }
      : null,
  });
}

function restore() {
  const saved: StoredWallet | null = loadWalletState();
  if (!saved) return;
  wallet.connected = saved.connected;
  wallet.external = new Map(
    Object.entries(saved.external).map(([key, value]) => [key, BigInt(value)]),
  );
  wallet.vault = new Map(Object.entries(saved.vault).map(([key, value]) => [key, BigInt(value)]));
  const readClaims = (source: Record<string, Record<string, string>>) =>
    new Map<string, BranchClaims>(
      Object.entries(source).map(([key, value]) => [
        key,
        {
          stockYes: BigInt(value.stockYes ?? "0"),
          stockNo: BigInt(value.stockNo ?? "0"),
          quoteYes: BigInt(value.quoteYes ?? "0"),
          quoteNo: BigInt(value.quoteNo ?? "0"),
        },
      ]),
    );
  wallet.claims = readClaims(saved.claims);
  wallet.externalClaims = readClaims(saved.externalClaims);
  wallet.orders = saved.orders;
  wallet.permission = saved.permission
    ? {
        granted: saved.permission.granted,
        revoked: saved.permission.revoked,
        expiresAt: saved.permission.expiresAt,
        maxOrderQuote: BigInt(saved.permission.maxOrderQuote),
        totalQuote: BigInt(saved.permission.totalQuote),
        remainingQuote: BigInt(saved.permission.remainingQuote),
      }
    : null;
}

export { ACCOUNT_ADDRESS, parsePriceRawX18 };
