"use client";
import Link from "next/link";
import { useState } from "react";
import { RefreshStatus } from "@/components/data/RefreshStatus";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { PriceChart } from "@/components/market/PriceChart";
import { ProbabilityGauge } from "@/components/market/ProbabilityGauge";
import { SpotReference } from "@/components/market/SpotReference";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { ClaimTable } from "@/components/portfolio/ClaimTable";
import { PositionTable } from "@/components/portfolio/PositionTable";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
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
import { compact, eventKey, impactPercent, midpoint, percent } from "@/lib/markets/presentation";
import { cn } from "@/lib/utils";
import { OrdersClient } from "@/modules/OrdersPageModule/components/OrdersClient";
import type { BranchBook, MarketView, TradeView } from "@/types/api";
import { MarketRules } from "./MarketRules";
import { OrderTicket } from "./OrderTicket";
import { TradeTable } from "./TradeTable";

const EMPTY_PROBABILITY: MarketView["probability"] = {
  ask: null,
  bid: null,
  observedAt: null,
  quality: "disconnected",
  value: null,
};

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
    [bookTab, setBookTab] = useState<"Order book" | "Trades">("Order book");
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
          <LoadingState>Loading market…</LoadingState>
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
    <Page variant="terminal" className="px-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 pt-4 pb-2">
        <div className="max-w-4xl">
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
            <h1 className="text-lg font-medium leading-6">{market.question}</h1>
            <ProbabilityGauge probability={market.probability} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-medium text-muted-foreground">
            <span>Cutoff {formatTime(market.cutoff)}</span>
            <LifecycleBadge state={market.lifecycle} />
            <Button variant="link" size="sm" onClick={() => setTab("rules")}>
              Rules
            </Button>
            <Link href={`/resolution?market=${market.id}`}>Resolution ↗</Link>
          </div>
        </div>
        <nav aria-label="Event asset" className="flex flex-wrap gap-2">
          {query.markets
            .filter((m) => eventKey(m) === eventKey(market))
            .map((m) => (
              <Button
                variant={m.id === market.id ? "secondary" : "ghost"}
                size="sm"
                key={m.id}
                render={
                  <Link
                    href={`/markets/${m.id}`}
                    aria-current={m.id === market.id ? "page" : undefined}
                  />
                }
                nativeButton={false}
              >
                <TokenIdentity symbol={m.ticker} metadata={m.baseTokenMetadata} showName={false} />
              </Button>
            ))}
        </nav>
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-y px-3 py-3">
        <Stat
          label={`${market.ticker}-YES`}
          value={formatNumber(midpoint(market.yes))}
          className="text-positive"
        />
        <Stat
          label={`${market.ticker}-NO`}
          value={formatNumber(midpoint(market.no))}
          className="text-danger"
        />
        <Stat
          label="Impact"
          value={percent(impactPercent(market))}
          className={(impactPercent(market) ?? 0) >= 0 ? "text-positive" : "text-danger"}
        />
        <SpotReference price={market.spotReference} />
        <div className="flex-1" />
        <Stat
          label="Book depth"
          value={
            market.bookQuality && market.bookQuality !== "available"
              ? "—"
              : `$${compact(market.yes.depthUsd + market.no.depthUsd)}`
          }
        />
      </div>
      <RefreshStatus active={query.isRefreshError} label="market data" />
      {market.bookQuality === "truncated" && (
        <DataError
          message={
            "Book display limit reached. Best-price and depth indicators are withheld; the API still reviews against its full candidate book."
          }
        />
      )}
      <div className="grid items-start gap-px bg-border min-[900px]:grid-cols-[minmax(0,1fr)_320px] min-[1280px]:grid-cols-[minmax(0,1fr)_280px_320px]">
        <PriceChart market={market} initialTrades={trades} />
        <Card
          variant="panel"
          className="h-full min-w-0 min-[900px]:col-start-1 min-[900px]:row-start-2 min-[1280px]:col-start-2 min-[1280px]:row-start-1"
        >
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="Book panel"
              options={["Order book", "Trades"]}
              value={bookTab}
              onChange={setBookTab}
            />
          </CardHeader>
          <RefreshStatus
            active={query.isRefreshError || market.bookQuality === "unavailable"}
            label="book data where available"
          />
          {bookTab === "Trades" ? (
            <TradeTable market={market} trades={trades} />
          ) : (
            <div className="grid grid-cols-2 divide-x">
              <BranchDepth
                book={market.yes}
                label={`${market.ticker}-YES`}
                available={market.bookQuality === "available"}
              />
              <BranchDepth
                book={market.no}
                label={`${market.ticker}-NO`}
                available={market.bookQuality === "available"}
              />
            </div>
          )}
          <p className="border-t px-3 py-3 text-xs font-medium leading-5 text-muted-foreground">
            Books are independent — a YES quote says nothing about NO liquidity.
          </p>
        </Card>
        <div className="h-full min-w-0 bg-card min-[900px]:col-start-2 min-[900px]:row-span-3 min-[900px]:row-start-1 min-[1280px]:col-start-3 min-[1280px]:row-span-2">
          <OrderTicket key={market.id} market={market} />
        </div>
        <Card
          variant="panel"
          className="h-full min-w-0 min-[900px]:col-start-1 min-[900px]:row-start-3 min-[1280px]:col-span-2 min-[1280px]:row-start-2"
        >
          <Tabs value={tab} onValueChange={setTab} className="gap-0">
            <TabsList aria-label="Market information">
              {[
                ["positions", "Your positions"],
                ["orders", "Open orders"],
                ["claims", "Claims"],
                ["trades", "Trades"],
                ["rules", "Rules"],
              ].map(
                ([value, label]) =>
                  value && (
                    <TabsTrigger key={value} value={value}>
                      {label}
                    </TabsTrigger>
                  ),
              )}
            </TabsList>
            <TabsContent value="positions">
              <PositionTable markets={[market]} inline />
            </TabsContent>
            <TabsContent value="orders">
              <OrdersClient markets={query.markets} marketIds={[market.id]} embedded />
            </TabsContent>
            <TabsContent value="claims">
              <div className="eyebrow px-3 pt-3 text-muted-foreground">
                Available conditional claims
              </div>
              <ClaimTable markets={[market]} />
            </TabsContent>
            <TabsContent value="trades">
              <RefreshStatus active={tradeQuery.isRefreshError} label="trades" />
              {tradeQuery.isInitialError ? (
                <DataError message="Trade history is unavailable." />
              ) : (
                <TradeTable market={market} trades={trades} />
              )}
            </TabsContent>
            <TabsContent value="rules">
              <MarketRules market={market} />
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
      <TableCell>{formatNumber(level.price)}</TableCell>
      <TableCell className="text-right">{formatNumber(level.quantity, 2)}</TableCell>
    </TableRow>
  );
  return (
    <div className="min-w-0 pb-3">
      <h3 className="px-2 py-2">
        <Badge variant={label.endsWith("YES") ? "positive" : "destructive"}>{label}</Badge>
      </h3>
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
              <TableCell colSpan={2}>{available ? "No asks" : "Updating asks…"}</TableCell>
            </TableRow>
          )}
          <TableRow>
            <TableCell colSpan={2}>
              <strong className="tabular-nums">{formatNumber(midpoint(book))}</strong>
              <span className="ml-2 text-xs text-muted-foreground">
                spr {formatNumber(book.spread)}
              </span>
            </TableCell>
          </TableRow>
          {book.bids.slice(0, 5).map((l) => row(l, false))}
          {!book.bids.length && (
            <TableRow>
              <TableCell colSpan={2}>{available ? "No bids" : "Updating bids…"}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
