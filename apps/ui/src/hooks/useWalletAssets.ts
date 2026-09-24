"use client";
import { spotUsdValue } from "@conditional-stocks/shared/spot-prices";
import { useWallet } from "@/components/providers/WalletProvider";
import type { TokenDisplayMetadata } from "@/lib/tokens/devnet";
import type { MarketView } from "@/types/api";
import { usePositions } from "./useProtocolData";

export interface WalletAssetDescriptor {
  token: string;
  symbol: string;
  metadata: TokenDisplayMetadata | undefined;
  decimals: number;
  reference: number | null;
}
/** Quote plus every listed issuer token (each its own pool, decimals and spot reference). */
export function assetsForMarkets(markets: MarketView[]): WalletAssetDescriptor[] {
  const assets = new Map<string, WalletAssetDescriptor>();
  for (const market of markets) {
    if (!assets.has(market.quoteToken))
      assets.set(market.quoteToken, {
        token: market.quoteToken,
        symbol: market.quoteTokenMetadata?.symbol ?? "USDC",
        metadata: market.quoteTokenMetadata,
        decimals: market.quoteTokenDecimals,
        reference: spotUsdValue(market.quoteSpotReference),
      });
    for (const leg of market.bases)
      if (!assets.has(leg.mint))
        assets.set(leg.mint, {
          token: leg.mint,
          symbol: leg.symbol,
          metadata: leg.metadata ?? market.assetMetadata,
          decimals: leg.decimals,
          reference: spotUsdValue(leg.spotReference),
        });
  }
  return [...assets.values()];
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
