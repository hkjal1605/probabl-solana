import Link from "next/link";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import type { MarketView } from "@/lib/api/types";
import { formatNumber, formatTime } from "@/lib/format/display";
import { compact, impactPercent, marketCategory, midpoint } from "@/lib/markets/presentation";
import { ImpactBar } from "./ImpactBar";

export function EventCard({ markets }: { markets: MarketView[] }) {
  const market = markets[0];
  if (!market) return null;
  return (
    <article className="panel min-w-0">
      <div className="flex flex-wrap items-center gap-3 p-5 sm:flex-nowrap">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-secondary font-mono text-[11px] font-semibold">
          {marketCategory(market) === "Macro"
            ? "FED"
            : marketCategory(market) === "Policy"
              ? "PRC"
              : market.ticker}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug tracking-tight">
            <Link href={`/markets/${market.id}`}>{market.question}</Link>
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs font-medium text-muted-foreground">
            {marketCategory(market)} · Cutoff {formatTime(market.cutoff)} ·{" "}
            <LifecycleBadge state={market.lifecycle} />
          </div>
        </div>
        <div className="ml-auto text-right">
          <b className="font-mono text-xl font-medium">
            {market.probability.quality === "valid" && market.probability.value !== null
              ? `${formatNumber(market.probability.value * 100, 0)}%`
              : "—"}
          </b>
          <p
            className="text-xs font-medium text-muted-foreground"
            title={`Source quality: ${market.probability.quality}`}
          >
            P(YES) · Polymarket
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[40px_68px_minmax(70px,1fr)_68px] items-center gap-2 border-t px-4 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground sm:grid-cols-[52px_90px_minmax(80px,1fr)_90px] sm:gap-3 sm:px-5">
        <span>ASSET</span>
        <span>IF YES</span>
        <span>IMPACT</span>
        <span>IF NO</span>
      </div>
      {markets.map((asset) => (
        <Link
          href={`/markets/${asset.id}`}
          key={asset.id}
          className="grid grid-cols-[40px_68px_minmax(70px,1fr)_68px] items-center gap-2 px-4 py-3 text-sm hover:bg-muted/50 sm:grid-cols-[52px_90px_minmax(80px,1fr)_90px] sm:gap-3 sm:px-5"
        >
          <strong>{asset.ticker}</strong>
          <span className="font-mono text-positive">{formatNumber(midpoint(asset.yes))}</span>
          <ImpactBar value={impactPercent(asset)} />
          <span className="font-mono text-muted-foreground">
            {formatNumber(midpoint(asset.no))}
          </span>
        </Link>
      ))}
      <div className="flex justify-between gap-3 border-t px-5 py-3 text-xs font-medium text-muted-foreground">
        <span>
          {markets.length} {markets.length === 1 ? "market" : "markets"} ·{" "}
          {markets.some((m) => m.bookQuality && m.bookQuality !== "available")
            ? "depth unavailable"
            : `$${compact(markets.reduce((sum, asset) => sum + asset.yes.depthUsd + asset.no.depthUsd, 0))} visible depth`}
        </span>
        <Link href={`/markets/${market.id}`} className="font-semibold text-foreground">
          Trade →
        </Link>
      </div>
    </article>
  );
}
