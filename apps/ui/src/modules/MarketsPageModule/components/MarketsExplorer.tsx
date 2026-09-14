"use client";
import Link from "next/link";
import { RefreshStatus } from "@/components/data/RefreshStatus";
import { EventCard } from "@/components/market/EventCard";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataError, EmptyState, LoadingState, Page, PageHeading, Stat } from "@/components/ui/page";
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
  compact,
  eventKey,
  groupMarkets,
  impactPercent,
  marketCategory,
  midpoint,
  percent,
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
  const depth = (assets: MarketView[]) =>
    assets.reduce((sum, m) => sum + m.yes.depthUsd + m.no.depthUsd, 0);
  const visible = groups
    .filter((assets) =>
      assets.some(
        (m) =>
          `${m.question} ${m.ticker} ${m.baseTokenMetadata?.name ?? ""}`
            .toLowerCase()
            .includes(filters.query.toLowerCase()) &&
          (filters.category === "All" || marketCategory(m) === filters.category) &&
          (filters.lifecycle === "all" ||
            (filters.lifecycle === "active" ? m.lifecycle === "open" : m.lifecycle !== "open")),
      ),
    )
    .sort((a, b) =>
      filters.sort === "depth"
        ? depth(b) - depth(a)
        : filters.sort === "impact"
          ? Math.max(...b.map((m) => Math.abs(impactPercent(m) ?? 0))) -
            Math.max(...a.map((m) => Math.abs(impactPercent(m) ?? 0)))
          : Date.parse(a[0]?.cutoff ?? "") - Date.parse(b[0]?.cutoff ?? ""),
    );
  // Mint identity, not a potentially shared display symbol, determines matrix columns.
  const tokens = [...new Map(markets.map((m) => [m.baseToken, m])).values()].sort((a, b) =>
    a.ticker.localeCompare(b.ticker),
  );
  return (
    <Page>
      <PageHeading
        title="Markets"
        description={
          <>
            Asset prices in the world where an event happens, and the world where it doesn’t.
            <br />
            The gap is the impact.
          </>
        }
      >
        <div className="flex flex-wrap gap-8">
          <Stat label="visible depth" value={`$${compact(depth(markets))}`} />
          <Stat label="open markets" value={markets.filter((m) => m.lifecycle === "open").length} />
          <Stat label="events" value={groups.length} />
        </div>
      </PageHeading>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented
          label="Market category"
          value={filters.category}
          options={["All", "Macro", "Earnings", "Policy", "Other"]}
          onChange={(category) => setFilters({ category })}
        />
        <Input
          className="w-full sm:w-56"
          aria-label="Search markets"
          placeholder="Search event, token or ticker"
          value={filters.query}
          onChange={(e) => setFilters({ query: e.target.value })}
        />
        <div className="hidden flex-1 xl:block" />
        <Select
          value={filters.lifecycle}
          items={{ active: "Active markets", resolving: "Resolution", all: "All lifecycle states" }}
          onValueChange={(value) => {
            if (value === "active" || value === "resolving" || value === "all")
              setFilters({ lifecycle: value });
          }}
        >
          <SelectTrigger aria-label="Lifecycle" className="w-auto">
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
          items={{ depth: "Depth ↓", impact: "Impact ↓", cutoff: "Cutoff ↑" }}
          onValueChange={(value) => {
            if (value === "depth" || value === "impact" || value === "cutoff")
              setFilters({ sort: value });
          }}
        >
          <SelectTrigger aria-label="Sort markets" className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="depth">Depth ↓</SelectItem>
              <SelectItem value="impact">Impact ↓</SelectItem>
              <SelectItem value="cutoff">Cutoff ↑</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Segmented
          label="Market view"
          value={filters.view}
          options={["Feed", "Matrix"]}
          onChange={(view) => setFilters({ view })}
        />
      </div>
      <RefreshStatus active={query.isRefreshError} label="markets" />
      {query.isInitialError && (
        <DataError
          retry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.isPending && !visible.length ? (
        <LoadingState>Loading markets…</LoadingState>
      ) : !visible.length ? (
        <EmptyState>No markets match this view. Try another filter.</EmptyState>
      ) : filters.view === "Feed" ? (
        <div className="grid gap-[18px] min-[1101px]:grid-cols-2">
          {visible.map((assets) => (
            <EventCard key={assets[0] ? eventKey(assets[0]) : "empty"} markets={assets} />
          ))}
        </div>
      ) : (
        <Card className="">
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
                    <TableCell className="font-mono">
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
