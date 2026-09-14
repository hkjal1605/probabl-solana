"use client";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { api } from "@/lib/api/client";
import type { MarketView } from "@/lib/api/types";
import { withMarketSpotPrices } from "@/lib/api/spot-prices";
import { useSpotPrices } from "./useSpotPrices";
import { readPollInterval } from "@/lib/api/read-policy";
import { useReadFreshness } from "./useReadFreshness";
import { retainBookDisplays } from "@/lib/markets/refresh";

const deployment = [protocolConfig.genesisHash, protocolConfig.programId, protocolConfig.config];

export function useMarkets(initial: MarketView[] = [], marketId?: string) {
  const query = useQuery({
    queryKey: ["markets", ...deployment, marketId ?? "all"],
    queryFn: ({ signal }) => api.markets(signal, marketId),
    ...(initial.length ? { initialData: { markets: initial } } : {}),
    refetchInterval: readPollInterval,
    structuralSharing: (previous, next) =>
      retainBookDisplays(previous, next as { markets: MarketView[] }),
  });
  const spot = useSpotPrices(query.data?.markets ?? initial);
  const freshness = useReadFreshness(query);
  const markets = withMarketSpotPrices(
    query.data?.markets ?? initial,
    spot.data,
    spot.now,
    spot.isError,
  );
  return {
    ...query,
    ...freshness,
    markets: freshness.isDataFresh
      ? markets
      : markets.map((m) => ({ ...m, bookQuality: "unavailable" as const })),
  };
}
export function useOrders() {
  const { account } = useWallet();
  const query = useQuery({
    queryKey: ["wallet-orders", account, ...deployment],
    queryFn: ({ signal }) => api.orders(account ?? "", signal),
    enabled: Boolean(account),
    refetchInterval: readPollInterval,
  });
  return { ...query, ...useReadFreshness(query), orders: query.data?.orders ?? [] };
}
export function usePositions() {
  const { account } = useWallet();
  const query = useQuery({
    queryKey: ["positions", account, ...deployment],
    queryFn: ({ signal }) => api.positions(account ?? "", signal),
    enabled: Boolean(account),
    refetchInterval: readPollInterval,
  });
  return { ...query, ...useReadFreshness(query), positions: query.data?.positions ?? [] };
}
export function useTrades(marketId: string) {
  const query = useQuery({
    queryKey: ["trades", marketId, ...deployment],
    queryFn: ({ signal }) => api.trades(marketId, signal),
    enabled: Boolean(marketId),
    refetchInterval: readPollInterval,
  });
  return {
    ...query,
    ...useReadFreshness(query),
    trades: query.data?.trades ?? [],
  };
}
