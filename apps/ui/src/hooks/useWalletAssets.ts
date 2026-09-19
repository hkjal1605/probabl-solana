"use client";
import { spotUsdValue } from "@conditional-stocks/shared/spot-prices";
import { useWallet } from "@/components/providers/WalletProvider";
import type { MarketView } from "@/types/api";
import { usePositions } from "./useProtocolData";

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
                symbol: market.quoteTokenMetadata?.symbol ?? "USDC",
                metadata: market.quoteTokenMetadata,
                decimals: market.quoteTokenDecimals,
                reference: spotUsdValue(market.quoteSpotReference),
              },
            ],
            [
              market.baseToken,
              {
                token: market.baseToken,
                symbol: market.ticker,
                metadata: market.baseTokenMetadata,
                decimals: market.baseTokenDecimals,
                reference: spotUsdValue(market.spotReference),
              },
            ],
          ] as const,
      ),
    ).values(),
  ];
}
export function useWalletAssets(markets: MarketView[]) {
  const { account } = useWallet(),
    query = usePositions(),
    assets = assetsForMarkets(markets);
  const balances = assets.flatMap((asset) => {
    const balance = query.data?.owner === account ? query.data.balances[asset.token] : undefined;
    return balance && balance.decimals === asset.decimals ? [{ ...asset, balance }] : [];
  });
  return { ...query, assets, balances };
}

export type WalletAsset = ReturnType<typeof assetsForMarkets>[number];
export type WalletAssetBalance = ReturnType<typeof useWalletAssets>["balances"][number];
