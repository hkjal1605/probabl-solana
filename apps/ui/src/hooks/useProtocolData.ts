"use client";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { api } from "@/lib/api/client";
import type { MarketView } from "@/lib/api/types";

export function useMarkets(initial: MarketView[] = []) {
  const query = useQuery({
    queryKey: ["markets", protocolConfig.chainId],
    queryFn: ({ signal }) => api.markets(signal),
    ...(initial.length ? { initialData: { markets: initial } } : {}),
    refetchInterval: 10_000,
  });
  return { ...query, markets: query.data?.markets ?? initial };
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
