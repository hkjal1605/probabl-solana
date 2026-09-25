"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import {
  displayPrice,
  formatNumber,
  formatTime,
  shareAmount,
  tokenAmount,
} from "@/lib/format/display";
import { legByCollateral } from "@/lib/markets/legs";
import { tradeHistoryCsv, type WalletTradeRow } from "@/lib/portfolio/presentation";
import { cn } from "@/lib/utils";

export function PortfolioTradeHistory({
  rows,
  isPending = false,
}: {
  rows: WalletTradeRow[];
  isPending?: boolean;
}) {
  const exportCsv = () => {
    const url = URL.createObjectURL(
      new Blob([tradeHistoryCsv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "probabl-trade-history.csv";
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <Card variant="panel" className="rounded-xl bg-card lg:sticky lg:top-20">
      <CardHeader className="flex flex-row items-center justify-between gap-4 border-0 px-0 pt-0 pb-4 group-data-[variant=panel]/card:pt-0 group-data-[variant=panel]/card:pb-4">
        <CardTitle className="text-base">Trade history</CardTitle>
        <Button variant="secondary" size="sm" disabled={!rows.length} onClick={exportCsv}>
          Export CSV
        </Button>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        {isPending && !rows.length ? (
          <div role="status" aria-label="Loading trade history" className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} aria-hidden="true" className="flex flex-col gap-2 px-5 py-4 pl-7">
                <Skeleton className="h-5 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-4 w-2/5" />
              </div>
            ))}
          </div>
        ) : !rows.length ? (
          <EmptyState>No wallet fills yet.</EmptyState>
        ) : (
          <ol className="list-none">
            {rows.slice(0, 20).map(({ market, order, side, trade }) => {
              const quantity = shareAmount(trade.fillQuantity, market);
              const leg =
                trade.base === undefined ? undefined : legByCollateral(market, trade.base);
              const price = displayPrice(trade.executionPriceRawX18, market);
              const quote = trade.executionQuote
                ? tokenAmount(trade.executionQuote, market.quoteTokenDecimals)
                : quantity * price;
              return (
                <li key={trade.id} className="relative px-5 py-4 pl-7">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute inset-y-0 left-0 w-0.5",
                      side === "Buy"
                        ? "bg-positive"
                        : side === "Sell"
                          ? "bg-destructive"
                          : "bg-warning",
                    )}
                  />
                  <p className="font-medium">
                    {side} <span className="tabular-nums">{formatNumber(quantity, 4)}</span>{" "}
                    {leg?.symbol ?? market.ticker}-{trade.branch === 0 ? "YES" : "NO"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-muted-foreground tabular-nums">
                    @ {formatNumber(price)} · {formatNumber(quote, 2)} USDC
                  </p>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">
                    {formatTime(new Date(Number(trade.blockTimestamp) * 1000).toISOString())}
                    {order.status === "open" ? " · Partial fill" : ""}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
