"use client";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { api } from "@/lib/api/client";
import type { MarketView } from "@/lib/api/types";
import { withMarketSpotPrices } from "@/lib/api/spot-prices";
import { useSpotPrices } from "./useSpotPrices";

export function useMarkets(initial: MarketView[] = []) {
  const query = useQuery({
    queryKey: ["markets", protocolConfig.genesisHash, protocolConfig.config],
    queryFn: ({ signal }) => api.markets(signal),
    ...(initial.length ? { initialData: { markets: initial } } : {}),
    refetchInterval: 10_000,
  });
  const spot = useSpotPrices(query.data?.markets ?? initial);
  return {
    ...query,
    markets: withMarketSpotPrices(query.data?.markets ?? initial, spot.data, spot.now, spot.isError),
  };
}
export function useOrders() {
  const { account } = useWallet();
  const query = useQuery({
    queryKey: ["wallet-orders", account, protocolConfig.genesisHash],
    queryFn: ({ signal }) => api.orders(account ?? "", signal),
    enabled: Boolean(account),
    refetchInterval: 6_000,
  });
  return { ...query, orders: query.data?.orders ?? [] };
}
export function usePositions() {
  const { account } = useWallet();
  const query = useQuery({
    queryKey: ["positions", account, protocolConfig.genesisHash],
    queryFn: ({ signal }) => api.positions(account ?? "", signal),
    enabled: Boolean(account),
    refetchInterval: 8_000,
  });
  return { ...query, positions: query.data?.positions ?? [] };
}
export function useTrades(marketId: string) {
  const query = useQuery({
    queryKey: ["trades", marketId, protocolConfig.chainId],
    queryFn: ({ signal }) => api.trades(marketId, signal),
    enabled: Boolean(marketId),
    refetchInterval: 5_000,
  });
  return {
    ...query,
    trades: query.data?.trades ?? [],
  };
}
