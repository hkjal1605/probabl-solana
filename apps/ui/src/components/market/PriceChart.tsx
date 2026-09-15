"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/ui/page";
import { Segmented } from "@/components/ui/segmented";
import { useTrades } from "@/hooks/useProtocolData";
import { formatNumber } from "@/lib/format/display";
import { executionImpact, executionPoints } from "@/lib/markets/history";
import type { MarketView, TradeView } from "@/types/api";

const durations = { "1H": 3600, "1D": 86400, "1W": 604800, ALL: Infinity };
const chartConfig = {
  yes: { label: "YES", color: "var(--positive)" },
  no: { label: "NO", color: "var(--danger)" },
  impact: { label: "Last-execution impact", color: "var(--positive)" },
};

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
  // Null means no execution for that branch, never a fabricated zero or spot price.
  const data = points.map((p) => ({
    at: p.at,
    yes: p.branch === 0 ? p.price : null,
    no: p.branch === 1 ? p.price : null,
    impact: p.price,
  }));
  const chart =
    mode === "vs Spot" ? (
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
      <ChartContainer
        config={chartConfig}
        className="h-full min-h-[360px] w-full xl:min-h-0"
        aria-label={
          mode === "Impact %"
            ? "Relative impact of last executed branch prices"
            : "Indexed YES and NO execution prices"
        }
      >
        <LineChart accessibilityLayer data={data} margin={{ left: 0, right: 12, top: 12 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="at"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickLine={false}
            axisLine={false}
            tickFormatter={(at: number) =>
              new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            }
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={55}
            domain={["auto", "auto"]}
            tickFormatter={(value: number) => formatNumber(value)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  payload[0]?.payload?.at
                    ? new Date(Number(payload[0].payload.at) * 1000).toLocaleString()
                    : ""
                }
                formatter={(value, name) => (
                  <span>
                    {chartConfig[name as keyof typeof chartConfig]?.label}:{" "}
                    {formatNumber(Number(value))}
                    {mode === "Impact %" ? "%" : " USDC"}
                  </span>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {(mode === "Impact %" ? ["impact"] : ["yes", "no"]).map((branch) => (
            <Line
              key={branch}
              dataKey={branch}
              type="linear"
              stroke={`var(--color-${branch})`}
              strokeWidth={2}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    );
  if (mini)
    return (
      <figure className="min-w-0" aria-label="Conditional stock chart">
        {chart}
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
      <CardContent className="flex min-h-[360px] flex-1 flex-col justify-center px-0 xl:min-h-0">
        {chart}
      </CardContent>
      {mode === "Impact %" && (
        <CardFooter className="flex-wrap justify-between gap-2">
          <span>Last-execution impact · not quote history</span>
        </CardFooter>
      )}
    </Card>
  );
}
