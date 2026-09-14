"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import { Tabs, TabsContent } from "@conditional-stocks/ui-kit/tabs";
import Link from "next/link";
import { useState } from "react";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { RefreshStatus } from "@/components/data/RefreshStatus";
import { PriceChart } from "@/components/market/PriceChart";
import { SpotReference } from "@/components/market/SpotReference";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { ClaimTable } from "@/components/portfolio/ClaimTable";
import { PositionTable } from "@/components/portfolio/PositionTable";
import {
  LineTabsList as TabsList,
  LineTabsTrigger as TabsTrigger,
} from "@/components/ui/line-tabs";
import { DataError, EmptyState, Page, Stat } from "@/components/ui/page";
import { Segmented } from "@/components/ui/segmented";
import { useProbabilityStream } from "@/hooks/useProbabilityStream";
import { useMarkets, useTrades } from "@/hooks/useProtocolData";
import type { BranchBook, MarketView, TradeView } from "@/lib/api/types";
import { formatNumber, formatTime } from "@/lib/format/display";
import {
  compact,
  eventKey,
  impactPercent,
  marketCategory,
  midpoint,
  percent,
} from "@/lib/markets/presentation";
import { OrdersClient } from "@/modules/OrdersPageModule/components/OrdersClient";
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
  const query = useMarkets(initialMarkets.filter((m) => m.id === marketId), marketId),
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
        ) : (
          <EmptyState>
            {query.isPending ? "Loading market…" : "Market not found in the canonical indexer."}
            <Button asChild variant="outline">
              <Link href="/markets">Explore markets</Link>
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
      <nav aria-label="Breadcrumb" className="mb-4 text-xs font-medium text-muted-foreground">
        <Link href="/markets">Markets</Link> / {marketCategory(market)} / {market.ticker}
      </nav>
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
                asChild
                variant={m.id === market.id ? "secondary" : "ghost"}
                size="sm"
                key={m.id}
              >
                <Link
                  href={`/markets/${m.id}`}
                  aria-current={m.id === market.id ? "page" : undefined}
                >
                  <TokenIdentity
                    symbol={m.ticker}
                    metadata={m.baseTokenMetadata}
                    showName={false}
                  />
                </Link>
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
        <section className="panel min-w-0 min-[761px]:col-start-1 min-[761px]:row-start-2 min-[1101px]:col-start-2 min-[1101px]:row-start-1">
          <div className="panel-heading">
            <Segmented
              label="Book panel"
              options={["Order book", "Trades"]}
              value={bookTab}
              onChange={setBookTab}
            />
          </div>
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
        </section>
        <div className="min-[761px]:col-start-2 min-[761px]:row-span-2 min-[761px]:row-start-1 min-[1101px]:col-start-3">
          <OrderTicket key={market.id} market={market} />
        </div>
        <section className="panel min-w-0 min-[761px]:col-span-2 min-[761px]:row-start-3 min-[1101px]:row-start-2">
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
        </section>
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
    <div
      key={level.priceExact}
      className={`relative flex justify-between px-3 py-1.5 font-mono text-xs ${ask ? "text-danger" : "text-positive"}`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 right-0 ${ask ? "bg-danger-soft" : "bg-positive-soft"}`}
        style={{ width: `${(level.quantity / max) * 100}%` }}
      />
      <span className="relative">{formatNumber(level.price)}</span>
      <span className="relative">{formatNumber(level.quantity, 2)}</span>
    </div>
  );
  return (
    <div className="min-w-0 pb-3">
      <h3
        className={`px-3 pt-4 pb-3 text-xs font-semibold ${label.endsWith("YES") ? "text-positive" : "text-danger"}`}
      >
        {label}
      </h3>
      <div className="flex justify-between px-3 pb-2 text-[11px] font-semibold text-muted-foreground">
        <span>PRICE</span>
        <span>SIZE</span>
      </div>
      {[...book.asks.slice(0, 5)].reverse().map((l) => row(l, true))}
      {!book.asks.length && (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {available ? "No asks" : "Updating asks…"}
        </p>
      )}
      <div className="my-2 border-y px-3 py-3">
        <strong className="font-mono">{formatNumber(midpoint(book))}</strong>
        <span className="ml-2 text-xs text-muted-foreground">spr {formatNumber(book.spread)}</span>
      </div>
      {book.bids.slice(0, 5).map((l) => row(l, false))}
      {!book.bids.length && (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {available ? "No bids" : "Updating bids…"}
        </p>
      )}
    </div>
  );
}
