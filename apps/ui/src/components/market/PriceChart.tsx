"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/page";
import { useTrades } from "@/hooks/useProtocolData";
import type { MarketView, TradeView } from "@/lib/api/types";
import { formatNumber } from "@/lib/format/display";
import { executionImpact, executionPoints } from "@/lib/markets/history";
import { cn } from "@/lib/utils";

const durations = { "1H": 3600, "1D": 86400, "1W": 604800, ALL: Infinity };
export function PriceChart({
  market,
  mini = false,
  initialTrades = [],
}: {
  market: MarketView | null;
  mini?: boolean;
  initialTrades?: TradeView[];
}) {
  const query = useTrades(market?.id ?? "");
  const [range, setRange] = useState<keyof typeof durations>("1D");
  const [mode, setMode] = useState("YES vs NO");
  const [hover, setHover] = useState<number | null>(null);
  const trades = query.data ? query.trades : query.trades.length ? query.trades : initialTrades;
  const since = Math.floor(Date.now() / 60000) * 60 - durations[range];
  const points = useMemo(() => {
    if (!market) return [];
    const points = executionPoints(trades, market);
    return (mode === "Impact %" ? executionImpact(points) : points).filter((p) => p.at >= since);
  }, [trades, market, since, mode]);
  const values = points.map((p) => p.price),
    min = Math.min(...values),
    max = Math.max(...values),
    padding = Math.max((max - min) * 0.15, 0.01);
  const lo = min - padding,
    hi = max + padding,
    start = points[0]?.at ?? 0,
    end = points.at(-1)?.at ?? start;
  const x = (at: number) => 16 + (end === start ? 0.5 : (at - start) / (end - start)) * 570;
  const y = (price: number) => 220 - ((price - lo) / (hi - lo)) * 200;
  const selected = hover === null ? null : points[Math.min(hover, points.length - 1)];
  return (
    <section
      className={cn("panel min-w-0 p-4", mini && "rounded-none border-0 bg-transparent p-0")}
      aria-label="Conditional stock chart"
    >
      {!mini && (
        <div className="mb-4 flex flex-wrap justify-between gap-2">
          <fieldset className="flex gap-1" aria-label="Chart mode">
            {["YES vs NO", "Impact %", "vs Spot"].map((value) => (
              <Button
                key={value}
                variant={mode === value ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
              >
                {value}
              </Button>
            ))}
          </fieldset>
          <fieldset className="flex" aria-label="Chart range">
            {(Object.keys(durations) as Array<keyof typeof durations>).map((value) => (
              <Button
                key={value}
                variant={range === value ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setRange(value)}
                aria-pressed={range === value}
              >
                {value}
              </Button>
            ))}
          </fieldset>
        </div>
      )}
      <div
        className="relative min-h-60"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.round(((event.clientX - rect.left) / rect.width) * (points.length - 1)),
            ),
          );
        }}
        onPointerLeave={() => setHover(null)}
      >
        {mode === "vs Spot" ? (
          <EmptyState>No verified historical spot feed is available.</EmptyState>
        ) : !points.length ? (
          <EmptyState>
            {query.isError
              ? "Price history is temporarily unavailable."
              : mode === "Impact %"
                ? "A settled trade in each branch is needed to compare execution prices."
                : "No indexed fills in this range. Try ALL or wait for trades to settle."}
          </EmptyState>
        ) : (
          <>
            {selected && (
              <div className="pointer-events-none absolute top-2 left-2 z-10 rounded border bg-popover p-2 text-xs shadow-sm">
                {new Date(selected.at * 1000).toLocaleString()}
                <br />
                {mode === "Impact %" ? "Execution impact" : selected.branch === 0 ? "YES" : "NO"}{" "}
                {formatNumber(selected.price)}
                {mode === "Impact %" ? "%" : " USDG"}
              </div>
            )}
            <svg
              viewBox="0 0 650 240"
              className="h-60 w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={
                mode === "Impact %"
                  ? "Relative impact of last executed branch prices"
                  : "Indexed YES and NO execution prices"
              }
            >
              <title>Canonical trade history</title>
              {[0.2, 0.5, 0.8].map((p) => (
                <g key={p}>
                  <line
                    x1="16"
                    x2="590"
                    y1={20 + p * 200}
                    y2={20 + p * 200}
                    stroke="var(--border)"
                  />
                  <text x="600" y={24 + p * 200} fill="var(--muted-foreground)" fontSize="10">
                    {formatNumber(hi - p * (hi - lo), 0)}
                  </text>
                </g>
              ))}
              {[0, 1].map((branch) => {
                const series = points.filter((p) => p.branch === branch);
                return (
                  <g key={branch}>
                    <path
                      d={series.map((p, i) => `${i ? "L" : "M"}${x(p.at)},${y(p.price)}`).join(" ")}
                      fill="none"
                      stroke={branch === 0 ? "var(--positive)" : "var(--danger)"}
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                    {series.map((p) => (
                      <circle
                        key={p.id}
                        cx={x(p.at)}
                        cy={y(p.price)}
                        r="2.5"
                        fill={branch === 0 ? "var(--positive)" : "var(--danger)"}
                      />
                    ))}
                  </g>
                );
              })}
            </svg>
          </>
        )}
      </div>
      {!mini && (
        <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs font-medium text-muted-foreground">
          <span>
            <span className="text-positive">
              {mode === "Impact %" ? "● Last-execution impact · not quote history" : "● YES"}
            </span>
            　{mode !== "Impact %" && <span className="text-danger">● NO</span>}
          </span>
          <span>Latest 100 canonical fills · not a price forecast</span>
        </div>
      )}
    </section>
  );
}
