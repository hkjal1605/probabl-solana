"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import { Input } from "@conditional-stocks/ui-kit/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conditional-stocks/ui-kit/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@conditional-stocks/ui-kit/table";
import Link from "next/link";
import { EventCard } from "@/components/market/EventCard";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { DataError, EmptyState, Page, PageHeading, Stat } from "@/components/ui/page";
import { Segmented } from "@/components/ui/segmented";
import { useMarkets } from "@/hooks/useProtocolData";
import { RefreshStatus } from "@/components/data/RefreshStatus";
import type { MarketView } from "@/types/api";
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
        <div className="flex gap-1">
          {["All", "Macro", "Earnings", "Policy", "Other"].map((category) => (
            <Button
              key={category}
              size="sm"
              variant={filters.category === category ? "secondary" : "ghost"}
              aria-pressed={filters.category === category}
              onClick={() => setFilters({ category })}
            >
              {category}
            </Button>
          ))}
        </div>
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
          onValueChange={(value) => {
            if (value === "active" || value === "resolving" || value === "all")
              setFilters({ lifecycle: value });
          }}
        >
          <SelectTrigger aria-label="Lifecycle" className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active markets</SelectItem>
            <SelectItem value="resolving">Resolution</SelectItem>
            <SelectItem value="all">All lifecycle states</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.sort}
          onValueChange={(value) => {
            if (value === "depth" || value === "impact" || value === "cutoff")
              setFilters({ sort: value });
          }}
        >
          <SelectTrigger aria-label="Sort markets" className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="depth">Depth ↓</SelectItem>
            <SelectItem value="impact">Impact ↓</SelectItem>
            <SelectItem value="cutoff">Cutoff ↑</SelectItem>
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
      {!visible.length ? (
        <EmptyState>
          {query.isPending ? "Loading markets…" : "No markets match this view. Try another filter."}
        </EmptyState>
      ) : filters.view === "Feed" ? (
        <div className="grid gap-[18px] min-[1101px]:grid-cols-2">
          {visible.map((assets) => (
            <EventCard key={assets[0] ? eventKey(assets[0]) : "empty"} markets={assets} />
          ))}
        </div>
      ) : (
        <div className="panel">
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
                            <Link
                              href={`/markets/${asset.id}`}
                              className={`block min-w-24 rounded-md px-4 py-3 text-center ${(impactPercent(asset) ?? 0) >= 0 ? "bg-positive-soft text-positive" : "bg-danger-soft text-danger"}`}
                            >
                              <b className="font-mono">{percent(impactPercent(asset))}</b>
                              <p className="mt-1 font-mono text-xs">
                                {formatNumber(midpoint(asset.yes))}
                              </p>
                            </Link>
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
        </div>
      )}
    </Page>
  );
}
