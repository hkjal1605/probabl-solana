"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import { EventCard } from "@/components/market/EventCard";
import { ProbabilityGauge } from "@/components/market/ProbabilityGauge";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataError, EmptyState, Page } from "@/components/ui/page";
import { Segmented } from "@/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMarkets } from "@/hooks/useProtocolData";
import { formatNumber } from "@/lib/format/display";
import {
  eventKey,
  groupMarkets,
  impactPercent,
  MARKET_CATEGORIES,
  type MarketCategory,
  marketAssetKey,
  marketCategory,
  marketCategoryFromPathname,
  marketCategoryPath,
  midpoint,
  percent,
  sortEventGroups,
} from "@/lib/markets/presentation";
import { cn } from "@/lib/utils";
import type { MarketView } from "@/types/api";
import { FEATURED_MARKETS } from "../featured-markets";
import { FeaturedMarketBanner } from "./FeaturedMarketBanner";
import { MarketsPageSkeleton } from "./MarketsPageSkeleton";

export function MarketsExplorer({
  markets: initial,
  now: _now,
  category: routeCategory,
}: {
  markets: MarketView[];
  now?: number;
  category: MarketCategory;
}) {
  const pathname = usePathname(),
    query = useMarkets(initial),
    markets = query.markets;
  const filters = useUiStore((s) => s.filters),
    setFilters = useUiStore((s) => s.setFilters);
  const pathnameCategory = marketCategoryFromPathname(pathname) ?? routeCategory;
  const [category, setCategory] = useState(pathnameCategory);
  useLayoutEffect(() => {
    setCategory(pathnameCategory);
    setFilters({ category: pathnameCategory });
  }, [pathnameCategory, setFilters]);
  const groups = groupMarkets(markets);
  const featuredDefinition = FEATURED_MARKETS[category];
  const featured =
    groups.find((assets) =>
      assets.some(
        (market) => market.mapping.conditionId.toLowerCase() === featuredDefinition.conditionId,
      ),
    ) ??
    groups.find((assets) => {
      const market = assets[0];
      return market && (category === "All" || marketCategory(market) === category);
    });
  const visible = sortEventGroups(
    groups.filter((assets) =>
      assets.some(
        (m) =>
          (category === "All" || marketCategory(m) === category) &&
          (filters.lifecycle === "all" ||
            (filters.lifecycle === "active" ? m.lifecycle === "open" : m.lifecycle !== "open")),
      ),
    ),
    filters.sort,
  );
  // Asset identity (all issuer legs of one stock), not a single mint or a
  // potentially shared display symbol, determines matrix columns.
  const tokens = [...new Map(markets.map((m) => [marketAssetKey(m), m])).values()].sort((a, b) =>
    a.ticker.localeCompare(b.ticker),
  );
  const showSkeleton = query.isPending && markets.length === 0;
  return (
    <Page variant="terminal" className="page-scrollbars-hidden max-w-[1350px] px-4 pt-4 lg:px-6">
      <section
        aria-label="Market filters"
        className="mb-4 flex min-h-8 items-center gap-4 overflow-x-auto"
      >
        <Segmented
          label="Market category"
          variant="category"
          className="shrink-0"
          value={category}
          options={MARKET_CATEGORIES}
          onChange={(nextCategory) => {
            setCategory(nextCategory);
            setFilters({ category: nextCategory });
            const nextPath = marketCategoryPath(nextCategory);
            if (window.location.pathname !== nextPath) window.history.pushState(null, "", nextPath);
          }}
        />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Select
            value={filters.lifecycle}
            items={{
              active: "Active markets",
              resolving: "Resolution",
              all: "All lifecycle states",
            }}
            onValueChange={(value) => {
              if (value === "active" || value === "resolving" || value === "all")
                setFilters({ lifecycle: value });
            }}
          >
            <SelectTrigger aria-label="Lifecycle" size="xs" variant="filter-chip">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="active">Active markets</SelectItem>
                <SelectItem value="resolving">Resolution</SelectItem>
                <SelectItem value="all">All lifecycle states</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={filters.sort}
            items={{ newest: "Newest first", oldest: "Oldest first" }}
            onValueChange={(value) => {
              if (value === "newest" || value === "oldest") setFilters({ sort: value });
            }}
          >
            <SelectTrigger aria-label="Sort markets" size="xs" variant="filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Segmented
            label="Market view"
            variant="compact"
            value={filters.view}
            options={["Feed", "Matrix"]}
            onChange={(view) => setFilters({ view })}
          />
        </div>
      </section>
      {showSkeleton ? (
        <MarketsPageSkeleton view={filters.view} />
      ) : (
        <>
          {featured && (
            <FeaturedMarketBanner
              category={category}
              imageSrc={featuredDefinition.imageSrc}
              markets={featured}
            />
          )}
          {query.isInitialError && (
            <DataError
              retry={() => {
                void query.refetch();
              }}
            />
          )}
          {!visible.length ? (
            <EmptyState>No markets match this view. Try another filter.</EmptyState>
          ) : filters.view === "Feed" ? (
            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((assets) => (
                <EventCard key={assets[0] ? eventKey(assets[0]) : "empty"} markets={assets} />
              ))}
            </div>
          ) : (
            <Card variant="panel">
              <Table>
                <TableHeader className="[&_tr]:border-b-0">
                  <TableRow className="border-b-0 hover:bg-transparent [&_th]:py-3">
                    <TableHead>Event</TableHead>
                    {tokens.map((token) => (
                      <TableHead key={marketAssetKey(token)} className="text-foreground">
                        <TokenIdentity
                          symbol={token.ticker}
                          metadata={token.assetMetadata}
                          showName={false}
                          iconSize="sm"
                        />
                      </TableHead>
                    ))}
                    <TableHead className="text-center font-medium text-foreground">
                      Probability
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((assets) => {
                    const market = assets[0];
                    if (!market) return null;
                    return (
                      <TableRow key={eventKey(market)} className="border-b-0">
                        <TableCell className="min-w-52 max-w-80 whitespace-normal">
                          <Link href={`/markets/${market.id}`} className="font-semibold">
                            {market.question}
                          </Link>
                          <p className="mt-2 text-xs font-medium text-muted-foreground">
                            {marketCategory(market)} · {market.lifecycle}
                          </p>
                        </TableCell>
                        {tokens.map((token) => {
                          const asset = assets.find(
                            (m) => marketAssetKey(m) === marketAssetKey(token),
                          );
                          const impact = asset ? impactPercent(asset) : null;
                          return (
                            <TableCell key={marketAssetKey(token)}>
                              {asset ? (
                                <Link
                                  href={`/markets/${asset.id}`}
                                  className={cn(
                                    buttonVariants({ variant: "ghost" }),
                                    "h-auto min-w-24 flex-col gap-2 border-0 py-3",
                                    impact === null
                                      ? "bg-secondary hover:bg-secondary"
                                      : impact >= 0
                                        ? "bg-positive-soft hover:bg-positive-soft"
                                        : "bg-danger-soft hover:bg-danger-soft",
                                  )}
                                >
                                  <span
                                    className={cn(
                                      impact === null
                                        ? "text-muted-foreground"
                                        : impact >= 0
                                          ? "text-positive"
                                          : "text-destructive",
                                    )}
                                  >
                                    {percent(impact)}
                                  </span>
                                  <span>{formatNumber(midpoint(asset.yes))}</span>
                                </Link>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                          );
                        })}
                        <TableCell className="[&>[role=img]]:mx-auto">
                          <ProbabilityGauge
                            probability={market.probability}
                            conditionId={market.mapping.conditionId}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
