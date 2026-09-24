import {
  assertShareUnits,
  formatPriceRawX18,
  formatShareAmount,
  type ShareUnits,
  tokenDecimals,
} from "@conditional-stocks/domain";
import { polymarketImageUrl } from "@conditional-stocks/market-data";
import {
  ASSETS,
  claimAsset,
  legBit,
  MAX_BASES,
  underlyingAsset,
} from "@conditional-stocks/solana-client";
import {
  marketTokenDisplay,
  REPLICA_TOKEN_METADATA,
  replicaTokenMetadata,
  type TokenDisplayMetadata,
} from "../lib/tokens/devnet";
import type {
  BranchBook,
  LegLiveView,
  LevelBases,
  MarketLegView,
  MarketLifecycle,
  MarketView,
} from "../types/api";
import { requestJson } from "./api";
import { API_URL } from "./constants";
import { expireCachedProbability, parseProbabilityMessage } from "./probability";

const upstreamUrl = (_service: string) => API_URL;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const number = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const lifecycle = (state: unknown): MarketLifecycle =>
  (
    [
      "scheduled",
      "open",
      "frozen",
      "awaiting-resolution",
      "resolved",
      "redeemable",
      "archived",
    ] as const
  )[Math.max(0, Number(state) - 1)] ?? "scheduled";
const isoSeconds = (value: unknown) => {
  const seconds = number(value);
  return seconds === null ? new Date(0).toISOString() : new Date(seconds * 1_000).toISOString();
};
function metadataProbability(attached: Record<string, unknown>): MarketView["probability"] | null {
  const snapshot = record(attached.metadata);
  const raw = record(snapshot.rawPayload);
  const parseList = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const outcomes = parseList(raw.outcomes);
  const prices = parseList(raw.outcomePrices);
  const yes = outcomes.findIndex(
    (outcome) => typeof outcome === "string" && outcome.trim().toLowerCase() === "yes",
  );
  const value = number(prices[yes]);
  if (yes < 0 || value === null || value < 0 || value > 1) return null;
  const observed = number(snapshot.fetchedAtMs);
  return {
    ask: null,
    bid: null,
    observedAt: observed === null ? null : new Date(observed).toISOString(),
    quality: "stale",
    value,
  };
}
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DIGITS = /^(0|[1-9][0-9]{0,39})$/;
const HALTS = new Set([
  "delisted",
  "claims-uninitialized",
  "issuer-paused",
  "vault-frozen",
  "corporate-action",
  "transfer-hook",
  "unreadable",
]);
const mint = (value: unknown, label: string) => {
  if (typeof value !== "string" || !MINT.test(value)) throw new Error(`Invalid ${label} mint`);
  return value;
};
const digits = (value: unknown, label: string) => {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !DIGITS.test(raw)) throw new Error(`Invalid ${label}`);
  return raw;
};
const claimPair = (value: unknown, label: string) => {
  const pair = record(value);
  return { yes: mint(pair.yes, `${label} YES`), no: mint(pair.no, `${label} NO`) };
};
function liveLeg(value: unknown): LegLiveView | undefined {
  if (value === undefined || value === null) return undefined;
  const live = record(value);
  const halt = live.halt === null || live.halt === undefined ? null : live.halt;
  if (
    typeof live.paused !== "boolean" ||
    typeof live.vaultFrozen !== "boolean" ||
    typeof live.tradable !== "boolean" ||
    typeof live.multiplierValue !== "number" ||
    !Number.isFinite(live.multiplierValue) ||
    (halt !== null && (typeof halt !== "string" || !HALTS.has(halt))) ||
    live.tradable !== (halt === null)
  )
    throw new Error("Invalid live issuer state");
  return {
    multiplier: digits(live.multiplier, "live multiplier"),
    multiplierValue: live.multiplierValue,
    paused: live.paused,
    vaultFrozen: live.vaultFrozen,
    tradable: live.tradable,
    halt: halt as LegLiveView["halt"],
  };
}

/** v3 base legs: up to MAX_BASES issuer tokens in collateral order, each matching the asset
 * table. A newly created market lists the quote only until its first `add_base`. */
export function parseMarketLegs(
  market: Record<string, unknown>,
  claimMints: string[],
): Omit<MarketLegView, "symbol" | "issuer" | "metadata">[] {
  const bases = market.bases;
  if (!Array.isArray(bases) || bases.length > MAX_BASES)
    throw new Error("A v3 market lists at most three issuer legs");
  return bases.map((value, index) => {
    const leg = record(value);
    const collateral = index + 1;
    if (leg.collateral !== collateral || leg.bit !== legBit(collateral))
      throw new Error("Issuer legs must be listed in collateral order");
    if (typeof leg.active !== "boolean" || typeof leg.ready !== "boolean")
      throw new Error("Invalid issuer leg state");
    const parsed = {
      collateral,
      bit: legBit(collateral),
      mint: mint(leg.mint, "issuer"),
      decimals: tokenDecimals(leg.decimals),
      scale: digits(leg.scale, "leg scale"),
      listingMultiplier: digits(leg.listingMultiplier, "listing multiplier"),
      active: leg.active,
      ready: leg.ready,
      claimMints: claimPair(leg.claimMints, "leg claim"),
    };
    if (
      claimMints[underlyingAsset(collateral)] !== parsed.mint ||
      claimMints[claimAsset(collateral, 0)] !== parsed.claimMints.yes ||
      claimMints[claimAsset(collateral, 1)] !== parsed.claimMints.no ||
      BigInt(parsed.scale) !==
        10n ** BigInt(Math.max(0, parsed.decimals - Number(market.shareDecimals))) ||
      parsed.decimals < Number(market.shareDecimals)
    )
      throw new Error("Issuer leg differs from the market asset table");
    const live = liveLeg(leg.live);
    return live ? { ...parsed, live } : parsed;
  });
}

function parseLevelBases(value: unknown, units: ShareUnits): LevelBases[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.entries(value as Record<string, unknown>)
    .map(([mask, remaining]) => {
      const bits = Number(mask);
      const raw = BigInt(digits(remaining, "level remaining"));
      if (!Number.isInteger(bits) || bits <= 0 || bits >= 1 << MAX_BASES)
        throw new Error("Invalid level issuer mask");
      return { mask: bits, quantityRaw: raw, quantity: 0 };
    })
    .filter((entry) => entry.quantityRaw > 0n)
    .sort((a, b) => a.mask - b.mask)
    .map((entry) => ({
      mask: entry.mask,
      quantityRaw: entry.quantityRaw.toString(),
      quantity: Number(formatShareAmount(entry.quantityRaw, units)),
    }));
}

/** Aggregate compact levels (`byBases`) or full indexed orders (`bases`) into one branch book. */
export function aggregateBook(
  orders: Record<string, unknown>[],
  branch: number,
  units: ShareUnits,
): BranchBook {
  const side = (value: number) => {
    const totals = new Map<bigint, { total: bigint; byBases: Map<number, bigint> | null }>();
    for (const order of orders) {
      if (Number(order.branch) !== branch || Number(order.side) !== value) continue;
      const price = BigInt(text(order.limitPriceRawX18));
      const remaining = BigInt(text(order.remaining));
      const entry = totals.get(price) ?? { total: 0n, byBases: new Map<number, bigint>() };
      entry.total += remaining;
      const breakdown =
        order.byBases !== undefined
          ? parseLevelBases(order.byBases, units)?.map(
              (item) => [item.mask, BigInt(item.quantityRaw)] as const,
            )
          : typeof order.bases === "number" && order.bases > 0
            ? [[order.bases, remaining] as const]
            : undefined;
      if (!breakdown) entry.byBases = null;
      else if (entry.byBases)
        for (const [mask, amount] of breakdown)
          entry.byBases.set(mask, (entry.byBases.get(mask) ?? 0n) + amount);
      totals.set(price, entry);
    }
    return [...totals]
      .sort(([a], [b]) => (a === b ? 0 : (a < b ? -1 : 1) * (value === 0 ? -1 : 1)))
      .map(([price, { total, byBases }]) => ({
        priceExact: formatPriceRawX18(price, units),
        price: Number(formatPriceRawX18(price, units)),
        quantity: Number(formatShareAmount(total, units)),
        ...(byBases?.size
          ? {
              byBases: [...byBases]
                .sort(([a], [b]) => a - b)
                .map(([mask, amount]) => ({
                  mask,
                  quantityRaw: amount.toString(),
                  quantity: Number(formatShareAmount(amount, units)),
                })),
            }
          : {}),
      }));
  };
  const bids = side(0);
  const asks = side(1);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    asks,
    bestAskExact: asks[0]?.priceExact ?? null,
    bestBidExact: bids[0]?.priceExact ?? null,
    bestAsk,
    bestBid,
    bids,
    depthUsd: [...bids, ...asks].reduce((total, item) => total + item.price * item.quantity, 0),
    spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
  };
}

/** The 12-entry asset mint table; quote claims must match `quoteClaimMints`. */
function parseAssetTable(market: Record<string, unknown>) {
  const table = market.claimMints;
  if (!Array.isArray(table) || table.length !== ASSETS)
    throw new Error("A v3 market carries all 12 asset mints");
  const claimMints = table.map((value, index) => mint(value, `asset ${index}`));
  const quoteToken = mint(market.quoteToken, "quote");
  const quoteClaimMints = claimPair(market.quoteClaimMints, "quote claim");
  if (
    claimMints[0] !== quoteToken ||
    claimMints[claimAsset(0, 0)] !== quoteClaimMints.yes ||
    claimMints[claimAsset(0, 1)] !== quoteClaimMints.no
  )
    throw new Error("Quote claims differ from the market asset table");
  return { claimMints, quoteToken, quoteClaimMints };
}

// The deployment's issuer replica mints as published by the API, reused for five
// minutes; the build-time list stays the fallback when the API cannot answer.
let replicaRead:
  | { at: number; value: Promise<Readonly<Record<string, TokenDisplayMetadata>>> }
  | undefined;
function replicaMetadata() {
  if (replicaRead && Date.now() - replicaRead.at < 300_000) return replicaRead.value;
  const read: NonNullable<typeof replicaRead> = {
    at: Date.now(),
    value: requestJson<{ replicas?: Record<string, string> }>("/v1/tokens/replicas").then(
      (body) => ({ ...REPLICA_TOKEN_METADATA, ...replicaTokenMetadata(body.replicas ?? {}) }),
      () => {
        if (replicaRead === read) replicaRead = undefined;
        return REPLICA_TOKEN_METADATA;
      },
    ),
  };
  replicaRead = read;
  return read.value;
}

async function liveMarkets(marketId?: string, signal?: AbortSignal): Promise<MarketView[]> {
  const replicasPromise = replicaMetadata();
  const json = <T>(url: string): Promise<T> =>
    requestJson<T>(new URL(url).pathname + new URL(url).search, signal ? { signal } : {});
  // Start the all-books projection with the market list. Once market identities
  // arrive, their metadata reads can overlap the remaining orderbook transfer.
  const batchPromise = marketId
    ? Promise.resolve(null)
    : json<{
        books: Record<
          string,
          { orders: Record<string, unknown>[]; truncated?: boolean; unavailable?: boolean }
        >;
      }>(`${upstreamUrl("indexer")}/orderbooks?view=levels`).catch(() => null);
  const marketResponse = marketId
    ? {
        markets: [
          await json<Record<string, unknown>>(
            `${upstreamUrl("indexer")}/markets/${encodeURIComponent(marketId)}`,
          ),
        ],
      }
    : await json<{ markets: Record<string, unknown>[] }>(`${upstreamUrl("indexer")}/markets`);
  // Sibling asset markets share one immutable Polymarket condition. Fetch its
  // metadata/probability once so one event cannot randomly diverge per asset.
  const attachments = new Map<string, Promise<Record<string, unknown>>>();
  for (const market of marketResponse.markets) {
    const condition = text(market.polymarketConditionId).toLowerCase();
    if (!attachments.has(condition)) {
      const id = text(market.id);
      attachments.set(
        condition,
        json<Record<string, unknown>>(`${upstreamUrl("api")}/v1/markets/${id}/polymarket`).catch(
          () => ({}),
        ),
      );
    }
  }
  const batch = await batchPromise;
  const replicas = await replicasPromise;
  return Promise.all(
    marketResponse.markets.map(async (market): Promise<MarketView> => {
      assertShareUnits(market);
      const id = text(market.id);
      const table = parseAssetTable(market);
      const legs = parseMarketLegs(market, table.claimMints);
      const condition = text(market.polymarketConditionId).toLowerCase();
      const [attached, book] = await Promise.all([
        attachments.get(condition) ?? Promise.resolve({}),
        marketId
          ? json<{ orders: Record<string, unknown>[]; truncated?: boolean; unavailable?: boolean }>(
              `${upstreamUrl("indexer")}/orderbook/${id}?limit=2000`,
            ).catch(() => ({ orders: [], unavailable: true, truncated: false }))
          : Promise.resolve(
              batch?.books?.[id] ?? { orders: [], unavailable: true, truncated: false },
            ),
      ]);
      const attachedRecord = record(attached);
      const metadata = record(record(attachedRecord.metadata).normalized);
      const probability = record(attachedRecord.probability);
      let probabilityView: MarketView["probability"] = {
        ask: null,
        bid: null,
        observedAt: null,
        quality: "disconnected",
        value: null,
      };
      try {
        probabilityView = expireCachedProbability(
          parseProbabilityMessage(
            { topic: `probability.${text(market.polymarketConditionId)}`, value: probability },
            text(market.polymarketConditionId),
          ),
        );
      } catch {
        /* Unverified reference data must not become a usable probability. */
      }
      if (probabilityView.value === null)
        probabilityView = metadataProbability(attachedRecord) ?? probabilityView;
      // A capped response cannot establish best prices or total depth on both sides.
      const usableOrders = book.truncated || book.unavailable ? [] : book.orders;
      const yes = aggregateBook(usableOrders, 0, market);
      const no = aggregateBook(usableOrders, 1, market);
      const yesMid =
        yes.bestBid !== null && yes.bestAsk !== null && yes.bestAsk >= yes.bestBid
          ? (yes.bestBid + yes.bestAsk) / 2
          : null;
      const noMid =
        no.bestBid !== null && no.bestAsk !== null && no.bestAsk >= no.bestBid
          ? (no.bestBid + no.bestAsk) / 2
          : null;
      const display = marketTokenDisplay(
        legs.map((leg) => leg.mint),
        table.quoteToken,
        process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH ?? "",
        text(record(metadata.asset).symbol, "STOCK"),
        replicas,
      );
      const bases: MarketLegView[] = legs.map((leg, index) => {
        const shown = display.legs[index] ?? { symbol: display.ticker, issuer: null };
        return {
          ...leg,
          symbol: shown.symbol,
          issuer: shown.issuer,
          ...(shown.metadata ? { metadata: shown.metadata } : {}),
        };
      });
      return {
        shareDecimals: market.shareDecimals,
        quoteTokenDecimals: market.quoteTokenDecimals,
        protocolVersion: market.protocolVersion,
        priceFormat: market.priceFormat,
        baseStep: text(market.baseStep),
        priceTickRawX18: text(market.priceTickRawX18, "1"),
        bookQuality: book.unavailable ? "unavailable" : book.truncated ? "truncated" : "available",
        bases,
        claimMints: table.claimMints,
        quoteClaimMints: table.quoteClaimMints,
        cutoff: isoSeconds(market.tradingCutoff),
        createdAt: text(market.createdAt) || null,
        description: text(
          metadata.rules,
          "Immutable conditional stock market with manual resolution.",
        ),
        eventImpact: yesMid !== null && noMid !== null ? yesMid - noMid : null,
        id,
        lifecycle: lifecycle(market.state),
        mapping: {
          conditionId: text(market.polymarketConditionId),
          noIndex: text(market.polymarketNoIndex),
          polymarketUrl: text(metadata.canonicalUrl, "https://polymarket.com"),
          yesIndex: text(market.polymarketYesIndex),
        },
        no,
        ordinaryReference: null,
        probability: probabilityView,
        question: text(metadata.question, `Conditional market ${id.slice(0, 8)}`),
        imageUrl:
          polymarketImageUrl(metadata) ??
          polymarketImageUrl(record(attachedRecord.metadata).rawPayload),
        quoteToken: table.quoteToken,
        residual: null,
        ticker: display.ticker,
        // A market without listed legs yet is its own asset until issuers are added.
        assetKey: bases.length ? display.assetKey : `market:${id}`,
        ...(display.assetMetadata ? { assetMetadata: display.assetMetadata } : {}),
        ...(display.quoteTokenMetadata ? { quoteTokenMetadata: display.quoteTokenMetadata } : {}),
        tradingOpen: isoSeconds(market.tradingOpen),
        yes,
      };
    }),
  );
}

export const marketsApi = { liveMarkets };
