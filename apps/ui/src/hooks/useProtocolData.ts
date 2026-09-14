"use client";
import { useWallet } from "@/components/providers/WalletProvider";
import type { MarketView } from "@/types/api";
import { withMarketSpotPrices } from "@/services/spot-prices";
import { marketsStore } from "@/stores/useMarketsStore";
import { ordersStore } from "@/stores/useOrdersStore";
import { positionsStore } from "@/stores/usePositionsStore";
import { tradesStore } from "@/stores/useTradesStore";
import { fetchMarkets } from "@/modules/MarketsPageModule/utils/fetchMarkets";
import { fetchOrders } from "@/modules/OrdersPageModule/utils/fetchOrders";
import { fetchPositions } from "@/modules/PortfolioPageModule/utils/fetchPositions";
import { fetchTrades } from "@/modules/MarketDetailPageModule/utils/fetchTrades";
import { useResource } from "./useResource";
import { useSpotPrices } from "./useSpotPrices";
import { useReadFreshness } from "./useReadFreshness";

export function useMarkets(initial: MarketView[] = [], marketId?: string) {
  const key = marketId ?? "all";
  const query = useResource(marketsStore, key, (force) => fetchMarkets(key, force));
  const rows = query.data?.markets ?? initial;
  const spot = useSpotPrices(rows),
    freshness = useReadFreshness(query);
  const markets = withMarketSpotPrices(rows, spot.data, spot.now, spot.isError);
  return {
    ...query,
    ...freshness,
    markets: freshness.isDataFresh
      ? markets
      : markets.map((m) => ({ ...m, bookQuality: "unavailable" as const })),
  };
}
export function useOrders() {
  const { account } = useWallet(),
    key = account ?? "";
  const query = useResource(ordersStore, key, (force) => fetchOrders(key, force), !!account);
  return { ...query, ...useReadFreshness(query), orders: query.data?.orders ?? [] };
}
export function usePositions() {
  const { account } = useWallet(),
    key = account ?? "";
  const query = useResource(positionsStore, key, (force) => fetchPositions(key, force), !!account);
  return { ...query, ...useReadFreshness(query), positions: query.data?.positions ?? [] };
}
export function useTrades(marketId: string) {
  const query = useResource(
    tradesStore,
    marketId,
    (force) => fetchTrades(marketId, force),
    !!marketId,
  );
  return { ...query, ...useReadFreshness(query), trades: query.data?.trades ?? [] };
}
