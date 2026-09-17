import Link from "next/link";
import { formatNumber } from "@/lib/format/display";
import { midpoint, percent, spotImpactPercent } from "@/lib/markets/presentation";
import { cn } from "@/lib/utils";
import type { MarketView } from "@/types/api";

export function OutcomePrice({ market, branch }: { market: MarketView; branch: "YES" | "NO" }) {
  const book = branch === "YES" ? market.yes : market.no;
  const mid = midpoint(book);
  const crossed =
    book.bestAsk !== null && book.bestBid !== null && book.bestAsk < book.bestBid;
  // A one-sided book has a real executable quote, but no defensible midpoint.
  // Label that quote explicitly instead of showing an unexplained empty price.
  const price = crossed ? null : mid ?? book.bestAsk ?? book.bestBid;
  const sideLabel =
    crossed || mid !== null
      ? null
      : book.bestAsk !== null
        ? "Ask"
        : book.bestBid !== null
          ? "Bid"
          : null;
  const impact = spotImpactPercent(market, branch);
  return (
    <Link
      href={`/markets/${market.id}`}
      aria-label={`If ${branch}: ${sideLabel ? `${sideLabel} ` : ""}${formatNumber(price)}, ${impact === null ? "spot impact unavailable" : `${percent(impact)} versus spot`}`}
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm px-2 py-1 tabular-nums to-transparent",
        branch === "YES" ? "bg-linear-to-l" : "flex-row-reverse bg-linear-to-r text-right",
        impact !== null && impact > 0 && "from-positive/10",
        impact !== null && impact < 0 && "from-destructive/10",
      )}
    >
      <span className="font-medium">{formatNumber(price)}</span>
      {sideLabel && <span className="text-xs text-muted-foreground">{sideLabel}</span>}
      <span
        className={cn(
          "text-xs",
          impact === null || impact === 0
            ? "text-muted-foreground"
            : impact > 0
              ? "text-positive"
              : "text-destructive",
        )}
      >
        {percent(impact)}
      </span>
    </Link>
  );
}
