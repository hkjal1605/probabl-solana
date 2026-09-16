"use client";

import type { LineData, UTCTimestamp } from "lightweight-charts";
import { useMemo, useState } from "react";
import {
  type LightweightChartSeries,
  LightweightPriceChart,
} from "@/components/market/LightweightPriceChart";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { useTrades } from "@/hooks/useProtocolData";
import { executionImpact, executionPoints, type PricePoint } from "@/lib/markets/history";
import type { MarketView, TradeView } from "@/types/api";

const durations = { "1H": 3600, "1D": 86400, "1W": 604800, ALL: Infinity };

function lineData(points: PricePoint[], branch?: number): LineData<UTCTimestamp>[] {
  const byTime = new Map<number, number>();
  for (const point of points)
    if (branch === undefined || point.branch === branch)
      byTime.set(Math.floor(point.at), point.price);
  return [...byTime]
    .sort(([left], [right]) => left - right)
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

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
  const trades = query.data ? query.trades : query.trades.length ? query.trades : initialTrades;
  const since = Math.floor(Date.now() / 60000) * 60 - durations[range];
  const points = useMemo(() => {
    if (!market) return [];
    const executions = executionPoints(trades, market);
    return (mode === "Impact %" ? executionImpact(executions) : executions).filter(
      (p) => p.at >= since,
    );
  }, [trades, market, since, mode]);
  const chartSeries = useMemo<LightweightChartSeries[]>(() => {
    if (mode === "vs Spot") return [];
    if (mode === "Impact %")
      return [
        {
          colorToken: "primary",
          data: lineData(points),
          id: "impact",
          label: "Impact",
        },
      ];
    return [
      {
        colorToken: "positive",
        data: lineData(points, 0),
        id: "yes",
        label: "YES",
      },
      {
        colorToken: "danger",
        data: lineData(points, 1),
        id: "no",
        label: "NO",
      },
    ];
  }, [mode, points]);
  const emptyMessage =
    mode === "vs Spot"
      ? "No verified historical spot feed is available."
      : points.length
        ? undefined
        : query.isError
          ? "Price history is temporarily unavailable."
          : mode === "Impact %"
            ? "A settled trade in each branch is needed to compare execution prices."
            : "No indexed fills in this range. Try ALL or wait for trades to settle.";
  const chart = (
    <LightweightPriceChart
      ariaLabel={
        mode === "Impact %"
          ? "Relative impact of last executed branch prices"
          : mode === "vs Spot"
            ? "Execution prices compared with historical spot"
            : "Indexed YES and NO execution prices"
      }
      compactScale={mode === "YES vs NO"}
      emptyMessage={emptyMessage}
      series={chartSeries}
      valueSuffix={mode === "Impact %" ? "%" : " USDC"}
    />
  );
  const viewport = (
    <div
      className={
        mini ? "flex aspect-video min-h-40 w-full" : "flex h-full min-h-[360px] w-full xl:min-h-0"
      }
    >
      {chart}
    </div>
  );
  if (mini)
    return (
      <figure className="min-w-0" aria-label="Conditional stock chart">
        {viewport}
      </figure>
    );
  return (
    <Card variant="panel" className="h-full min-h-0 min-w-0" aria-label="Conditional stock chart">
      <CardHeader className="flex flex-wrap justify-between gap-2">
        <Segmented
          label="Chart mode"
          variant="chart"
          value={mode}
          options={["YES vs NO", "Impact %", "vs Spot"]}
          onChange={setMode}
        />
        <Segmented
          label="Chart range"
          variant="timeframe"
          value={range}
          options={["1H", "1D", "1W", "ALL"]}
          onChange={setRange}
        />
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 px-0">{viewport}</CardContent>
    </Card>
  );
}
