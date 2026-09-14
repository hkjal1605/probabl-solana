"use client";
import Link from "next/link";
import { useState } from "react";
import { RefreshStatus } from "@/components/data/RefreshStatus";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { PriceChart } from "@/components/market/PriceChart";
import { SpotReference } from "@/components/market/SpotReference";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { ClaimTable } from "@/components/portfolio/ClaimTable";
import { PositionTable } from "@/components/portfolio/PositionTable";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
import {
  compact,
  eventKey,
  impactPercent,
  marketCategory,
  midpoint,
  percent,
} from "@/lib/markets/presentation";
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
    <Page className="pt-6 lg:pt-6">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/markets" />}>Markets</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>{marketCategory(market)}</BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{market.ticker}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-4xl">
          <h1 className="text-2xl font-semibold leading-tight tracking-[-0.04em] sm:text-[28px]">
            {market.ticker} · {market.question}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs font-medium text-muted-foreground">
            <span>
              P(YES){" "}
              <b className="font-mono text-foreground">
                {market.probability.quality === "valid" && market.probability.value !== null
                  ? `${formatNumber(market.probability.value * 100, 0)}%`
                  : "—"}
              </b>{" "}
              · Polymarket
            </span>
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
      <div className="my-5 flex flex-wrap gap-8 border-y py-4">
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
      <div className="grid items-start gap-4 min-[761px]:grid-cols-[minmax(0,1fr)_300px] min-[1101px]:grid-cols-[minmax(0,1fr)_clamp(320px,27vw,380px)_clamp(360px,30vw,420px)]">
        <PriceChart market={market} initialTrades={trades} />
        <Card className="min-w-0 min-[761px]:col-start-1 min-[761px]:row-start-2 min-[1101px]:col-start-2 min-[1101px]:row-start-1">
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
        <div className="min-[761px]:col-start-2 min-[761px]:row-span-2 min-[761px]:row-start-1 min-[1101px]:col-start-3">
          <OrderTicket key={market.id} market={market} />
        </div>
        <Card className="min-w-0 min-[761px]:col-span-2 min-[761px]:row-start-3 min-[1101px]:row-start-2">
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
              <div className="eyebrow px-5 pt-5 text-muted-foreground">
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
      className={cn("font-mono", ask ? "text-danger" : "text-positive")}
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
      <h3 className="px-3 pb-3">
        <Badge variant={label.endsWith("YES") ? "positive" : "destructive"}>{label}</Badge>
      </h3>
      <Table aria-label={label}>
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
              <strong className="font-mono">{formatNumber(midpoint(book))}</strong>
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
