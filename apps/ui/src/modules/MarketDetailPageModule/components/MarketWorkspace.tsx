"use client";
import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
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
import { visibleDepthPerSide } from "@/lib/markets/visible-depth";
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
            <Button variant="outline" render={<Link href="/" />} nativeButton={false}>
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
    <Page
      variant="terminal"
      className="market-workspace-scrollbars-hidden flex min-h-0 flex-col bg-secondary px-0 py-0 xl:overflow-hidden"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 bg-background px-3 py-3">
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
      <div className="market-workspace-grid grid min-h-0 flex-1 items-stretch gap-0.5 bg-secondary p-0.5 xl:overflow-hidden">
        <div className="market-workspace-stats overflow-hidden rounded-[4px] bg-background">
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
        <div className="market-workspace-chart min-h-0 min-w-0 overflow-hidden rounded-[4px]">
          <PriceChart market={market} initialTrades={trades} />
        </div>
        <Card
          variant="panel"
          className="market-workspace-book min-h-0 min-w-0 data-[variant=panel]:rounded-[4px]"
        >
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="Order book outcome"
              variant="chart"
              options={[`${market.ticker}-YES`, `${market.ticker}-NO`]}
              value={`${market.ticker}-${bookBranch}`}
              onChange={(value) => setBookBranch(value === `${market.ticker}-YES` ? "YES" : "NO")}
            />
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-0">
            <BranchDepth
              book={bookBranch === "YES" ? market.yes : market.no}
              label={`${market.ticker}-${bookBranch}`}
              available={market.bookQuality === "available"}
            />
          </CardContent>
        </Card>
        <div className="market-workspace-ticket min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-[4px] bg-card">
          <OrderTicket key={market.id} market={market} />
        </div>
        <Card
          variant="panel"
          className="market-workspace-information min-h-0 min-w-0 overflow-hidden data-[variant=panel]:rounded-[4px]"
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleLevels, setVisibleLevels] = useState(5);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const header = container.querySelector<HTMLElement>("thead")?.getBoundingClientRect().height;
      const midpointRow = container
        .querySelector<HTMLElement>("[data-depth-midpoint]")
        ?.getBoundingClientRect().height;
      if (!header || !midpointRow || container.clientHeight <= 0) return;
      const next = visibleDepthPerSide(container.clientHeight, header, midpointRow);
      setVisibleLevels((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const quoteSize = (level: BranchBook["asks"][number]) => level.price * level.quantity;
  const cumulative = (levels: BranchBook["asks"]) => {
    let total = 0;
    return levels.map((level) => {
      total += quoteSize(level);
      return { ...level, cumulativeSize: total };
    });
  };
  const asks = cumulative(book.asks.slice(0, visibleLevels));
  const bids = cumulative(book.bids.slice(0, visibleLevels));
  const askTotal = asks.at(-1)?.cumulativeSize ?? 0;
  const bidTotal = bids.at(-1)?.cumulativeSize ?? 0;
  const row = (
    level: BranchBook["asks"][number] & { cumulativeSize: number },
    ask: boolean,
    total: number,
  ) => (
    <TableRow
      key={level.priceExact}
      className={cn("tabular-nums", ask ? "text-danger" : "text-positive")}
      style={{
        backgroundImage: `linear-gradient(to left, var(--${ask ? "danger" : "positive"}-soft) ${total > 0 ? (level.cumulativeSize / total) * 100 : 0}%, transparent ${total > 0 ? (level.cumulativeSize / total) * 100 : 0}%)`,
      }}
    >
      <TableCell className="text-sm">{formatNumber(level.price)}</TableCell>
      <TableCell className="text-right text-sm">{formatNumber(quoteSize(level), 2)}</TableCell>
      <TableCell className="text-right text-sm">{formatNumber(level.cumulativeSize, 2)}</TableCell>
    </TableRow>
  );
  const emptyRow = (ask: boolean) => (
    <TableRow key={`${ask ? "ask" : "bid"}-empty`}>
      <TableCell colSpan={3} className="text-muted-foreground">
        {available ? `No ${ask ? "asks" : "bids"}` : "—"}
      </TableCell>
    </TableRow>
  );
  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 min-w-0 flex-col justify-center overflow-hidden"
    >
      <Table aria-label={label} density="compact">
        <TableHeader className="[&_tr]:border-b-0">
          <TableRow className="hover:bg-transparent [&_th]:font-medium">
            <TableHead>Price</TableHead>
            <TableHead className="text-right">Size (USDC)</TableHead>
            <TableHead className="text-right">Size (Cumm)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-b-0">
          {asks.length === 0 && emptyRow(true)}
          {[...asks].reverse().map((level) => row(level, true, askTotal))}
          <TableRow data-depth-midpoint>
            <TableCell colSpan={3}>
              <strong className="text-sm tabular-nums">{formatNumber(midpoint(book))}</strong>
              <span className="ml-2 text-xs text-muted-foreground">
                spr <span className="text-sm">{formatNumber(book.spread)}</span>
              </span>
            </TableCell>
          </TableRow>
          {bids.map((level) => row(level, false, bidTotal))}
          {bids.length === 0 && emptyRow(false)}
        </TableBody>
      </Table>
    </div>
  );
}
