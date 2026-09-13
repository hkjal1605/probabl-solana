"use client";
import { useQueries } from "@tanstack/react-query";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { api } from "@/lib/api/client";
import type { MarketView } from "@/lib/api/types";

export function assetsForMarkets(markets: MarketView[]) {
  return [
    ...new Map(
      markets.flatMap(
        (market) =>
          [
            [
              market.quoteToken,
              {
                token: market.quoteToken,
                symbol: "USDG",
                decimals: market.quoteTokenDecimals,
                reference: 1,
              },
            ],
            [
              market.baseToken,
              {
                token: market.baseToken,
                symbol: market.ticker,
                decimals: market.baseTokenDecimals,
                reference: market.ordinaryReference,
              },
            ],
          ] as const,
      ),
    ).values(),
  ];
}
export function useWalletAssets(markets: MarketView[]) {
  const { account } = useWallet(),
    assets = assetsForMarkets(markets);
  // One cache entry per account/chain/token: the ticket, Funds and Portfolio share each RPC-backed balance read.
  const queries = useQueries({
    queries: assets.map((asset) => ({
      queryKey: [
        "whole-balances",
        account,
        protocolConfig.chainId,
        asset.token,
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const balance = await api.balance(account ?? "", asset.token, signal);
        if (
          balance.account !== account ||
          balance.token !== asset.token ||
          balance.decimals !== asset.decimals ||
          !/^(0|[1-9][0-9]{0,77})$/.test(balance.canonicalBalance) ||
          BigInt(balance.canonicalBalance) >= 1n << 64n ||
          Object.values(balance.creditBalances??{}).some(n=>!/^(0|[1-9][0-9]{0,19})$/.test(n)||BigInt(n)>=1n<<64n)
        )
          throw new Error("Invalid canonical balance or token metadata.");
        return balance;
      },
      enabled: Boolean(account),
      refetchInterval: 8000,
    })),
  });
  const balances = assets.flatMap((asset, index) => {
    const balance = queries[index]?.data;
    return balance ? [{ ...asset, balance }] : [];
  });
  return {
    assets,
    balances,
    isPending: queries.some((q) => q.isPending),
    isFetching: queries.some((q) => q.isFetching),
    isError: queries.some((q) => q.isError),
    refetch: () => Promise.all(queries.map((q) => q.refetch())),
  };
}
