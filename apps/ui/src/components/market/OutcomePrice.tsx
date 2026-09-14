import Link from "next/link";
import { formatNumber } from "@/lib/format/display";
import { midpoint, percent, spotImpactPercent } from "@/lib/markets/presentation";
import { cn } from "@/lib/utils";
import type { MarketView } from "@/types/api";

export function OutcomePrice({ market, branch }: { market: MarketView; branch: "YES" | "NO" }) {
  const price = midpoint(branch === "YES" ? market.yes : market.no);
  const impact = spotImpactPercent(market, branch);
  return (
    <Link
      href={`/markets/${market.id}`}
      aria-label={`If ${branch}: ${formatNumber(price)}, ${impact === null ? "spot impact unavailable" : `${percent(impact)} versus spot`}`}
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm px-2 py-1 tabular-nums to-transparent",
        branch === "YES" ? "bg-linear-to-l" : "flex-row-reverse bg-linear-to-r text-right",
        impact !== null && impact > 0 && "from-positive/20",
        impact !== null && impact < 0 && "from-destructive/20",
      )}
    >
      <span className="font-medium">{formatNumber(price)}</span>
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
