import {
  assertMarketUnits,
  formatPriceRawX18,
  formatTokenAmount,
  type MarketUnits,
} from "@conditional-stocks/domain";
import { marketTokenDisplay } from "../lib/tokens/devnet";

import { expireProbability, parseProbabilityMessage } from "./probability";
import type { BranchBook, MarketLifecycle, MarketView } from "../types/api";
import { API_URL } from "./constants";
import { requestJson } from "./api";
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
function aggregateBook(
  orders: Record<string, unknown>[],
  branch: number,
  units: MarketUnits,
): BranchBook {
  const side = (value: number) => {
    const totals = new Map<bigint, bigint>();
    for (const order of orders) {
      if (Number(order.branch) !== branch || Number(order.side) !== value) continue;
      const price = BigInt(text(order.limitPriceRawX18));
      totals.set(price, (totals.get(price) ?? 0n) + BigInt(text(order.remaining)));
    }
    return [...totals]
      .sort(([a], [b]) => (a === b ? 0 : (a < b ? -1 : 1) * (value === 0 ? -1 : 1)))
      .map(([price, quantity]) => ({
        priceExact: formatPriceRawX18(price, units),
        price: Number(formatPriceRawX18(price, units)),
        quantity: Number(formatTokenAmount(quantity, units.baseTokenDecimals)),
      }));
  };
  const bids = side(0);
  const asks = side(1);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    asks: asks.slice(0, 12),
    bestAskExact: asks[0]?.priceExact ?? null,
    bestBidExact: bids[0]?.priceExact ?? null,
    bestAsk,
    bestBid,
    bids: bids.slice(0, 12),
    depthUsd: [...bids, ...asks].reduce((total, item) => total + item.price * item.quantity, 0),
    spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
  };
}

async function liveMarkets(marketId?: string, signal?: AbortSignal): Promise<MarketView[]> {
  const json = <T>(url: string): Promise<T> =>
    requestJson<T>(new URL(url).pathname + new URL(url).search, signal ? { signal } : {});
  const marketResponse = marketId
    ? {
        markets: [
          await json<Record<string, unknown>>(
            `${upstreamUrl("indexer")}/markets/${encodeURIComponent(marketId)}`,
          ),
        ],
      }
    : await json<{ markets: Record<string, unknown>[] }>(`${upstreamUrl("indexer")}/markets`);
  return Promise.all(
    marketResponse.markets.map(async (market): Promise<MarketView> => {
      assertMarketUnits(market);
      const id = text(market.id);
      const [attached, book] = await Promise.all([
        json<Record<string, unknown>>(`${upstreamUrl("api")}/v1/markets/${id}/polymarket`).catch(
          () => ({}),
        ),
        json<{ orders: Record<string, unknown>[]; truncated?: boolean; unavailable?: boolean }>(
          `${upstreamUrl("indexer")}/orderbook/${id}?limit=2000`,
        ).catch(() => ({ orders: [], unavailable: true, truncated: false })),
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
        probabilityView = expireProbability(
          parseProbabilityMessage(
            { topic: `probability.${text(market.polymarketConditionId)}`, value: probability },
            text(market.polymarketConditionId),
          ),
        );
      } catch {
        /* Unverified reference data must not become a usable probability. */
      }
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
      return {
        baseTokenDecimals: market.baseTokenDecimals,
        quoteTokenDecimals: market.quoteTokenDecimals,
        protocolVersion: market.protocolVersion,
        priceFormat: market.priceFormat,
        baseStep: text(market.baseStep),
        priceTickRawX18: text(market.priceTickRawX18, "1"),
        bookQuality: book.unavailable ? "unavailable" : book.truncated ? "truncated" : "available",
        baseToken: text(market.baseToken),
        cutoff: isoSeconds(market.tradingCutoff),
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
        quoteToken: text(market.quoteToken),
        residual: null,
        ...marketTokenDisplay(
          text(market.baseToken),
          text(market.quoteToken),
          process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH ?? "",
          text(record(metadata.asset).symbol, "STOCK"),
        ),
        tradingOpen: isoSeconds(market.tradingOpen),
        yes,
      };
    }),
  );
}

export const marketsApi = { liveMarkets };
