"use client";

import {
  ColorType,
  CrosshairMode,
  createChart,
  type LineData,
  LineSeries,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { formatNumber } from "@/lib/format/display";

export interface LightweightChartSeries {
  colorToken: "danger" | "positive" | "primary";
  data: LineData<UTCTimestamp>[];
  id: string;
  label: string;
}

interface LegendState {
  time: number | null;
  values: Record<string, number | null>;
}

const tokenColor = (styles: CSSStyleDeclaration, token: LightweightChartSeries["colorToken"]) =>
  styles.getPropertyValue(`--${token}`).trim();

const initialLegend = (series: LightweightChartSeries[]): LegendState => ({
  time: null,
  values: Object.fromEntries(series.map((item) => [item.id, item.data.at(-1)?.value ?? null])),
});

export function LightweightPriceChart({
  ariaLabel,
  compactScale = false,
  emptyMessage,
  series,
  valueSuffix,
}: {
  ariaLabel: string;
  compactScale?: boolean;
  emptyMessage?: string | undefined;
  series: LightweightChartSeries[];
  valueSuffix: "%" | " USDC";
}) {
  const container = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [legend, setLegend] = useState<LegendState>(() => initialLegend(series));

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    void resolvedTheme;
    const styles = getComputedStyle(document.documentElement);
    const muted = styles.getPropertyValue("--muted-foreground").trim();
    const border = styles.getPropertyValue("--border").trim();
    const chart = createChart(element, {
      autoSize: true,
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: {
          color: muted,
          labelVisible: false,
        },
        vertLine: { visible: false },
      },
      grid: {
        horzLines: { color: border },
        vertLines: { visible: false },
      },
      handleScale: false,
      layout: {
        attributionLogo: true,
        background: { color: "transparent", type: ColorType.Solid },
        fontFamily: getComputedStyle(element).fontFamily,
        textColor: styles.getPropertyValue("--muted-foreground").trim(),
      },
      localization: {
        priceFormatter: (value: number) =>
          `${formatNumber(value)}${valueSuffix === "%" ? "%" : ""}`,
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: compactScale ? { bottom: 0.3, top: 0.3 } : { bottom: 0.15, top: 0.15 },
      },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        lockVisibleTimeRangeOnResize: true,
        rightOffset: 2,
        secondsVisible: false,
        timeVisible: true,
      },
    });
    const apiById = new Map<string, ReturnType<typeof chart.addSeries>>();
    for (const item of series) {
      const api = chart.addSeries(LineSeries, {
        color: tokenColor(styles, item.colorToken),
        crosshairMarkerBorderColor: tokenColor(styles, item.colorToken),
        crosshairMarkerBackgroundColor: styles.getPropertyValue("--background").trim(),
        crosshairMarkerRadius: 4,
        lastValueVisible: true,
        lineWidth: 2,
        priceLineVisible: false,
        title: item.label,
      });
      api.setData(item.data);
      apiById.set(item.id, api);
    }
    const fallback = initialLegend(series);
    setLegend(fallback);
    const crosshair = (param: MouseEventParams) => {
      if (typeof param.time !== "number") {
        setLegend(fallback);
        return;
      }
      const values: Record<string, number | null> = {};
      for (const item of series) {
        const api = apiById.get(item.id);
        const point = api ? param.seriesData.get(api) : undefined;
        values[item.id] =
          point && "value" in point && typeof point.value === "number" ? point.value : null;
      }
      setLegend({ time: param.time, values });
    };
    chart.subscribeCrosshairMove(crosshair);
    if (series.some((item) => item.data.length)) chart.timeScale().fitContent();
    return () => {
      chart.unsubscribeCrosshairMove(crosshair);
      chart.remove();
    };
  }, [compactScale, resolvedTheme, series, valueSuffix]);

  return (
    <div className="relative size-full overflow-hidden" role="img" aria-label={ariaLabel}>
      <div ref={container} className="absolute inset-0" />
      <div className="pointer-events-none absolute top-2 left-3 z-10 flex flex-wrap items-center gap-3 text-xs tabular-nums">
        {series.map((item) => (
          <span key={item.id} className="inline-flex items-center gap-1.5">
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: `var(--${item.colorToken})` }}
            />
            <span className="text-muted-foreground">{item.label}</span>
            <span className="font-medium text-foreground">
              {legend.values[item.id] === null || legend.values[item.id] === undefined
                ? "—"
                : `${formatNumber(legend.values[item.id] ?? null)}${valueSuffix}`}
            </span>
          </span>
        ))}
        {legend.time !== null && (
          <span className="text-muted-foreground">
            {new Date(legend.time * 1000).toLocaleString()}
          </span>
        )}
      </div>
      {emptyMessage && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      )}
    </div>
  );
}
