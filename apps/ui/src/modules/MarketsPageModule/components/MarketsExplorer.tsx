"use client";
import Link from "next/link";
import { EventCard } from "@/components/market/EventCard";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  marketCategory,
  midpoint,
  percent,
  sortEventGroups,
} from "@/lib/markets/presentation";
import type { MarketView } from "@/types/api";

export function MarketsExplorer({
  markets: initial,
  now: _now,
}: {
  markets: MarketView[];
  now?: number;
}) {
  const query = useMarkets(initial),
    markets = query.markets;
  const filters = useUiStore((s) => s.filters),
    setFilters = useUiStore((s) => s.setFilters);
  const groups = groupMarkets(markets);
  const visible = sortEventGroups(groups
    .filter((assets) =>
      assets.some(
        (m) =>
          (filters.category === "All" || marketCategory(m) === filters.category) &&
          (filters.lifecycle === "all" ||
            (filters.lifecycle === "active" ? m.lifecycle === "open" : m.lifecycle !== "open")),
      ),
    ), filters.sort);
  // Mint identity, not a potentially shared display symbol, determines matrix columns.
  const tokens = [...new Map(markets.map((m) => [m.baseToken, m])).values()].sort((a, b) =>
    a.ticker.localeCompare(b.ticker),
  );
  return (
    <Page variant="terminal" className="pt-5">
      <div className="mb-4 overflow-x-auto">
        <Segmented
          label="Market category"
          variant="category"
          value={filters.category}
          options={["All", "Macro", "Earnings", "Policy", "Other"]}
          onChange={(category) => setFilters({ category })}
        />
      </div>
      <section
        aria-label="Market filters"
        className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2"
      >
        <div className="flex flex-wrap items-center gap-1">
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
              if (value === "newest" || value === "oldest")
                setFilters({ sort: value });
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
        </div>
        <Segmented
          label="Market view"
          variant="compact"
          value={filters.view}
          options={["Feed", "Matrix"]}
          onChange={(view) => setFilters({ view })}
        />
      </section>
      {query.isInitialError && (
        <DataError
          retry={() => {
            void query.refetch();
          }}
        />
      )}
      {!query.isPending && !visible.length ? (
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
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                {tokens.map((token) => (
                  <TableHead key={token.baseToken}>
                    <TokenIdentity symbol={token.ticker} metadata={token.baseTokenMetadata} />
                  </TableHead>
                ))}
                <TableHead>P(YES) · Polymarket</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((assets) => {
                const market = assets[0];
                if (!market) return null;
                return (
                  <TableRow key={eventKey(market)}>
                    <TableCell className="min-w-52 max-w-80 whitespace-normal">
                      <Link href={`/markets/${market.id}`} className="font-semibold">
                        {market.question}
                      </Link>
                      <p className="mt-2 text-xs font-medium text-muted-foreground">
                        {marketCategory(market)} · {market.lifecycle}
                      </p>
                    </TableCell>
                    {tokens.map((token) => {
                      const asset = assets.find((m) => m.baseToken === token.baseToken);
                      return (
                        <TableCell key={token.baseToken}>
                          {asset ? (
                            <Button
                              variant="outline"
                              nativeButton={false}
                              render={<Link href={`/markets/${asset.id}`} />}
                              className="h-auto min-w-24 flex-col gap-2 py-3"
                            >
                              <Badge
                                variant={
                                  impactPercent(asset) === null
                                    ? "secondary"
                                    : (impactPercent(asset) ?? 0) >= 0
                                      ? "positive"
                                      : "destructive"
                                }
                              >
                                {percent(impactPercent(asset))}
                              </Badge>
                              <span>{formatNumber(midpoint(asset.yes))}</span>
                            </Button>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="tabular-nums">
                      {market.probability.quality === "valid" && market.probability.value !== null
                        ? `${formatNumber(market.probability.value * 100, 0)}%`
                        : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
