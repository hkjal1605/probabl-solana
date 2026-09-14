"use client";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { PriceChart } from "@/components/market/PriceChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DataError } from "@/components/ui/page";
import { useMarkets } from "@/hooks/useProtocolData";
import { formatNumber } from "@/lib/format/display";
import {
  compact,
  impactPercent,
  marketCategory,
  midpoint,
  percent,
} from "@/lib/markets/presentation";
import type { MarketView } from "@/types/api";

export function Landing({ initialMarkets }: { initialMarkets: MarketView[] }) {
  const query = useMarkets(initialMarkets),
    markets = query.markets;
  const market = markets.find((m) => m.lifecycle === "open") ?? markets[0] ?? null;
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto grid w-full max-w-[1440px] flex-1 items-center gap-8 px-4 py-12 lg:grid-cols-2 lg:gap-12 lg:px-6">
        <div className="flex min-w-0 flex-col justify-center gap-6">
          <p className="eyebrow text-muted-foreground">Impact markets · Conditional stocks</p>
          <h1 className="text-4xl font-normal leading-[1.12] tracking-tight sm:text-5xl lg:text-[56px]">
            Prediction markets
            <br />
            price the odds.
            <br />
            <span className="text-primary">We price the impact.</span>
          </h1>
          <p className="max-w-[480px] text-base leading-6 text-muted-foreground">
            Trade NVDA, SPY or BTC inside the world where an event happens, and the world where it
            doesn’t. Don't just bet, hedge the consequence
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="default"
              size="lg"
              render={<Link href="/markets" />}
              nativeButton={false}
            >
              Launch app <ArrowUpRight />
            </Button>
            <Button
              variant="outline"
              size="lg"
              render={<Link href="/learn" />}
              nativeButton={false}
            >
              How it works
            </Button>
          </div>
          <div className="flex flex-wrap gap-6">
            <Metric
              label="visible depth"
              value={`$${compact(markets.reduce((sum, m) => sum + m.yes.depthUsd + m.no.depthUsd, 0))}`}
            />
            <Metric
              label="open markets"
              value={String(markets.filter((m) => m.lifecycle === "open").length)}
            />
            <Metric label="collateral" value="USDC" />
          </div>
          {query.isError && (
            <DataError
              retry={() => {
                void query.refetch();
              }}
            />
          )}
        </div>
        <div className="flex min-w-0 items-center justify-center">
          <Card variant="panel" className="w-full border">
            <CardHeader>
              <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs font-medium">
                <Badge variant="positive">
                  {market ? `${market.lifecycle} · ${marketCategory(market)}` : "Impact markets"}
                </Badge>
                <span className="tabular-nums text-muted-foreground">
                  P(YES){" "}
                  {market?.probability.quality === "valid"
                    ? `${formatNumber((market.probability.value ?? 0) * 100, 0)}%`
                    : "—"}{" "}
                  · Polymarket
                </span>
              </div>
              <CardTitle role="heading" aria-level={2}>
                {market?.question ?? "How does an event change a stock’s value?"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <PriceChart market={market} mini />
            </CardContent>
            <CardFooter className="grid grid-cols-2 gap-2.5">
              {(["YES", "NO"] as const).map((branch) => (
                <Card size="sm" key={branch} className="min-w-0">
                  <CardHeader className="flex flex-wrap justify-between gap-2">
                    <Badge variant={branch === "YES" ? "positive" : "destructive"}>
                      IF {branch}
                    </Badge>
                    <span className="tabular-nums">
                      {market ? percent(impactPercent(market, branch)) : "—"} impact
                    </span>
                  </CardHeader>
                  <CardContent>
                    {formatNumber(
                      market ? midpoint(branch === "YES" ? market.yes : market.no) : null,
                    )}
                  </CardContent>
                </Card>
              ))}
            </CardFooter>
          </Card>
        </div>
      </section>
      <section className="overflow-hidden border-y py-2" aria-label="Market impact ticker">
        <div className="market-ticker flex w-max">
          {[0, 1].map((repeat) => (
            <div key={repeat} className="flex shrink-0" aria-hidden={repeat === 1}>
              {markets
                .filter((m) => m.lifecycle === "open")
                .map((m) => (
                  <span key={m.id} className="flex items-center gap-3 border-r px-4 text-xs">
                    <b>{m.ticker}</b>
                    <span className="text-muted-foreground">if {m.question}</span>
                    <b className={(impactPercent(m) ?? 0) >= 0 ? "text-positive" : "text-danger"}>
                      {percent(impactPercent(m))}
                    </b>
                  </span>
                ))}
            </div>
          ))}
        </div>
        {markets.length === 0 && (
          <p className="px-8 text-xs text-muted-foreground">
            {query.isPending ? "Loading indexed markets…" : "No indexed markets available yet."}
          </p>
        )}
      </section>
    </main>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong className="tabular-nums text-base font-medium">{value}</strong>
      <div className="mt-2 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
