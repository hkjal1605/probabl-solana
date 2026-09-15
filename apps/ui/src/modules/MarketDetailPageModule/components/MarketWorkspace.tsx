"use client";
import Link from "next/link";
import { useState } from "react";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { PriceChart } from "@/components/market/PriceChart";
import { ProbabilityGauge } from "@/components/market/ProbabilityGauge";
import { SpotReference } from "@/components/market/SpotReference";
import { ClaimTable } from "@/components/portfolio/ClaimTable";
import { PositionTable } from "@/components/portfolio/PositionTable";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  LineTabsList as TabsList,
  LineTabsTrigger as TabsTrigger,
} from "@/components/ui/line-tabs";
import { DataError, EmptyState, LoadingState, Page, Stat } from "@/components/ui/page";
import { Segmented } from "@/components/ui/segmented";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useProbabilityStream } from "@/hooks/useProbabilityStream";
import { useMarkets, useTrades } from "@/hooks/useProtocolData";
import { formatNumber, formatTime } from "@/lib/format/display";
import { midpoint, percent, spotImpactPercent } from "@/lib/markets/presentation";
import { cn } from "@/lib/utils";
import { OrdersClient } from "@/modules/OrdersPageModule/components/OrdersClient";
import type { BranchBook, MarketView, TradeView } from "@/types/api";
import { MarketAssetSwitcher } from "./MarketAssetSwitcher";
import { MarketRulesDialog } from "./MarketRulesDialog";
import { OrderTicket } from "./OrderTicket";
import { TradeTable } from "./TradeTable";

const EMPTY_PROBABILITY: MarketView["probability"] = {
  ask: null,
  bid: null,
  observedAt: null,
  quality: "disconnected",
  value: null,
};

function OutcomeStat({ market, branch }: { market: MarketView; branch: "YES" | "NO" }) {
  const impact = spotImpactPercent(market, branch);
  return (
    <Stat
      variant="market"
      label={`${market.ticker}-${branch}`}
      value={
        <span className="flex items-baseline gap-1.5">
          <span>{formatNumber(midpoint(branch === "YES" ? market.yes : market.no))}</span>
          <span
            title={
              impact === null ? "Spot comparison unavailable" : `${percent(impact)} versus spot`
            }
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
        </span>
      }
    />
  );
}

export function MarketWorkspace({
  marketId,
  initialMarkets = [],
  initialTrades = [],
}: {
  marketId: string;
  initialMarkets?: MarketView[];
  initialTrades?: TradeView[];
}) {
  const query = useMarkets(
      initialMarkets.filter((m) => m.id === marketId),
      marketId,
    ),
    tradeQuery = useTrades(marketId);
  const indexedMarket = query.markets.find((m) => m.id === marketId);
  const stream = useProbabilityStream(
    indexedMarket?.mapping.conditionId ?? "",
    indexedMarket?.probability ?? EMPTY_PROBABILITY,
  );
  const market = indexedMarket ? { ...indexedMarket, probability: stream.probability } : undefined;
  const [tab, setTab] = useState("positions"),
    [bookBranch, setBookBranch] = useState<"YES" | "NO">("YES");
  if (!market)
    return (
      <Page>
        {query.isError ? (
          <DataError
            retry={() => {
              void query.refetch();
            }}
          />
        ) : query.isPending ? (
          <LoadingState />
        ) : (
          <EmptyState>
            Market not found in the canonical indexer.
            <Button variant="outline" render={<Link href="/markets" />} nativeButton={false}>
              Explore markets
            </Button>
          </EmptyState>
        )}
      </Page>
    );
  const trades = tradeQuery.data
    ? tradeQuery.trades
    : tradeQuery.trades.length
      ? tradeQuery.trades
      : initialTrades;
  return (
    <Page variant="terminal" className="flex min-h-0 flex-col px-0 py-0 xl:overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 pt-4 pb-2">
        <div className="min-w-0 flex-[1_1_28rem]">
          <div className="flex items-center gap-3">
            <Avatar size="lg" className="rounded-xl after:rounded-xl">
              {market.imageUrl && (
                <AvatarImage
                  src={market.imageUrl}
                  alt=""
                  className="rounded-xl"
                  referrerPolicy="no-referrer"
                />
              )}
              <AvatarFallback className="rounded-xl">{market.question.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h1 className="text-lg font-medium leading-6">{market.question}</h1>
              <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-muted-foreground">
                <span>Cutoff {formatTime(market.cutoff)}</span>
                <LifecycleBadge state={market.lifecycle} />
                <MarketRulesDialog market={market} />
              </div>
            </div>
            <ProbabilityGauge probability={market.probability} />
          </div>
        </div>
        <MarketAssetSwitcher market={market} />
      </div>
      <div className="market-workspace-grid grid min-h-0 flex-1 items-stretch gap-px bg-border xl:overflow-hidden">
        <div className="market-workspace-stats bg-background">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-y px-3 py-3">
            <OutcomeStat market={market} branch="YES" />
            <SpotReference price={market.spotReference} variant="market" />
            <OutcomeStat market={market} branch="NO" />
          </div>
          {market.bookQuality === "truncated" && (
            <DataError
              message={
                "Book display limit reached. Best-price and depth indicators are withheld; the API still reviews against its full candidate book."
              }
            />
          )}
        </div>
        <div className="market-workspace-chart min-h-0 min-w-0">
          <PriceChart market={market} initialTrades={trades} />
        </div>
        <Card variant="panel" className="market-workspace-book min-h-0 min-w-0">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="Order book outcome"
              variant="chart"
              options={[`${market.ticker}-YES`, `${market.ticker}-NO`]}
              value={`${market.ticker}-${bookBranch}`}
              onChange={(value) => setBookBranch(value === `${market.ticker}-YES` ? "YES" : "NO")}
            />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-center px-0">
            <BranchDepth
              book={bookBranch === "YES" ? market.yes : market.no}
              label={`${market.ticker}-${bookBranch}`}
              available={market.bookQuality === "available"}
            />
          </CardContent>
        </Card>
        <div className="market-workspace-ticket min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-card">
          <OrderTicket key={market.id} market={market} />
        </div>
        <Card
          variant="panel"
          className="market-workspace-information min-h-0 min-w-0 overflow-hidden"
        >
          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0 overflow-hidden">
            <TabsList aria-label="Market information">
              {[
                ["positions", "Your positions"],
                ["orders", "Open orders"],
                ["claims", "Claims"],
                ["trades", "Trades"],
              ].map(
                ([value, label]) =>
                  value && (
                    <TabsTrigger key={value} value={value}>
                      {label}
                    </TabsTrigger>
                  ),
              )}
            </TabsList>
            <TabsContent value="positions" className="min-h-0 overflow-auto overscroll-contain">
              <PositionTable markets={[market]} inline />
            </TabsContent>
            <TabsContent value="orders" className="min-h-0 overflow-auto overscroll-contain">
              <OrdersClient markets={query.markets} marketIds={[market.id]} embedded />
            </TabsContent>
            <TabsContent value="claims" className="min-h-0 overflow-auto overscroll-contain">
              <div className="eyebrow px-3 pt-3 text-muted-foreground">
                Available conditional claims
              </div>
              <ClaimTable markets={[market]} />
            </TabsContent>
            <TabsContent value="trades" className="min-h-0 overflow-auto overscroll-contain">
              {tradeQuery.isInitialError ? (
                <DataError message="Trade history is unavailable." />
              ) : (
                <TradeTable market={market} trades={trades} />
              )}
            </TabsContent>
          </Tabs>
        </Card>
      </div>
    </Page>
  );
}
function BranchDepth({
  book,
  label,
  available,
}: {
  book: BranchBook;
  label: string;
  available: boolean;
}) {
  const max = Math.max(1, ...book.bids.map((l) => l.quantity), ...book.asks.map((l) => l.quantity));
  const row = (level: BranchBook["asks"][number], ask: boolean) => (
    <TableRow
      key={level.priceExact}
      className={cn("tabular-nums", ask ? "text-danger" : "text-positive")}
      style={{
        backgroundImage: `linear-gradient(to left, var(--${ask ? "danger" : "positive"}-soft) ${(level.quantity / max) * 100}%, transparent ${(level.quantity / max) * 100}%)`,
      }}
    >
      <TableCell className="text-sm">{formatNumber(level.price)}</TableCell>
      <TableCell className="text-right text-sm">{formatNumber(level.quantity, 2)}</TableCell>
    </TableRow>
  );
  return (
    <div className="min-w-0">
      <Table aria-label={label} density="compact">
        <TableHeader>
          <TableRow>
            <TableHead>Price</TableHead>
            <TableHead className="text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...book.asks.slice(0, 5)].reverse().map((l) => row(l, true))}
          {!book.asks.length && (
            <TableRow>
              <TableCell colSpan={2}>{available ? "No asks" : "—"}</TableCell>
            </TableRow>
          )}
          <TableRow>
            <TableCell colSpan={2}>
              <strong className="text-sm tabular-nums">{formatNumber(midpoint(book))}</strong>
              <span className="ml-2 text-xs text-muted-foreground">
                spr <span className="text-sm">{formatNumber(book.spread)}</span>
              </span>
            </TableCell>
          </TableRow>
          {book.bids.slice(0, 5).map((l) => row(l, false))}
          {!book.bids.length && (
            <TableRow>
              <TableCell colSpan={2}>{available ? "No bids" : "—"}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
