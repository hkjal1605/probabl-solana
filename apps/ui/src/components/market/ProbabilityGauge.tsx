"use client";
import { useProbabilityStream } from "@/hooks/useProbabilityStream";
import { formatNumber } from "@/lib/format/display";
import { cn } from "@/lib/utils";
import type { MarketView } from "@/types/api";

export function ProbabilityGauge({
  probability: initial,
  conditionId = "",
}: {
  probability: MarketView["probability"];
  conditionId?: string;
}) {
  const { probability: source } = useProbabilityStream(conditionId, initial);
  const probability =
    source.value !== null && Number.isFinite(source.value) && source.value >= 0 && source.value <= 1
      ? source.value * 100
      : null;
  return (
    <div
      className="relative ml-auto h-12 w-16 shrink-0"
      role="img"
      aria-label={
        probability === null
          ? "Yes probability unavailable"
          : `Yes probability: ${formatNumber(probability, 0)}%`
      }
    >
      <svg viewBox="0 0 64 48" className="size-full" fill="none" aria-hidden="true">
        <path
          d="M 4 36 A 28 28 0 0 1 60 36"
          className="stroke-muted-foreground/30"
          strokeWidth="4"
          strokeLinecap="round"
        />
        {probability !== null && probability > 0 && (
          <path
            d="M 4 36 A 28 28 0 0 1 60 36"
            className={cn({
              "stroke-destructive": probability < 30,
              "stroke-warning": probability >= 30 && probability <= 70,
              "stroke-positive": probability > 70,
            })}
            strokeWidth="4"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray={`${probability} 100`}
          />
        )}
      </svg>
      <span className="absolute inset-x-0 top-6 text-center text-base font-medium leading-4 tabular-nums">
        {probability === null ? "—" : `${formatNumber(probability, 0)}%`}
      </span>
    </div>
  );
}
