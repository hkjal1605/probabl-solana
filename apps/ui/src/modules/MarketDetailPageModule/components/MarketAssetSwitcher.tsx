"use client";
import Link from "next/link";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { Button, buttonVariants } from "@/components/ui/button";
import { useMarketCatalogue } from "@/hooks/useMarketCatalogue";
import type { MarketView } from "@/types/api";
import { relatedMarkets } from "../utils/relatedMarkets";

export function MarketAssetSwitcher({ market }: { market: MarketView }) {
  const catalogue = useMarketCatalogue();
  const assets = relatedMarkets(market, catalogue.markets);
  return (
    <nav
      aria-label="Event assets"
      className="ml-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl p-1 sm:mt-0.5"
    >
      {assets.map((asset) => (
        <Link
          key={asset.id}
          href={`/markets/${asset.id}`}
          aria-current={asset.id === market.id ? "page" : undefined}
          className={buttonVariants({ variant: asset.id === market.id ? "secondary" : "ghost" })}
        >
          <TokenIdentity
            symbol={asset.ticker}
            metadata={asset.assetMetadata}
            showName={false}
            iconSize="sm"
          />
          {assets.some((other) => other.id !== asset.id && other.assetKey === asset.assetKey) && (
            <span className="text-xs text-muted-foreground">
              / {asset.quoteTokenMetadata?.symbol ?? asset.quoteToken.slice(0, 6)}
            </span>
          )}
        </Link>
      ))}
      {catalogue.error && (
        <Button variant="ghost" size="sm" onClick={catalogue.retry}>
          Retry assets
        </Button>
      )}
    </nav>
  );
}
