"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { PriceChart } from "@/components/market/PriceChart";
import { DataError } from "@/components/ui/page";
import { useMarkets } from "@/hooks/useProtocolData";
import type { MarketView } from "@/lib/api/types";
import { formatNumber } from "@/lib/format/display";
import {
  compact,
  impactPercent,
  marketCategory,
  midpoint,
  percent,
} from "@/lib/markets/presentation";

export function Landing({ initialMarkets }: { initialMarkets: MarketView[] }) {
  const query = useMarkets(initialMarkets),
    markets = query.markets;
  const market = markets.find((m) => m.lifecycle === "open") ?? markets[0] ?? null;
  return (
    <main className="flex flex-1 flex-col">
      <section className="grid flex-1 md:grid-cols-[1.05fr_1fr]">
        <div className="flex flex-col justify-center px-6 py-14 md:py-24 md:pr-10 md:pl-[max(40px,calc((100vw_-_1336px)/2))]">
          <p className="eyebrow text-muted-foreground">Impact markets · Conditional stocks</p>
          <h1 className="mt-6 text-5xl leading-[1.06] font-semibold tracking-[-0.065em] lg:text-[64px]">
            Prediction markets
            <br />
            price the odds.
            <br />
            <span className="text-positive">We price the impact.</span>
          </h1>
          <p className="mt-6 max-w-[480px] text-base leading-7 text-muted-foreground">
            Trade NVDA, SPY or BTC inside the world where an event happens, and the world where it
            doesn’t. Don't just bet, hedge the consequence
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Button asChild variant="brand" size="lg">
              <Link href="/markets">
                Launch app <ArrowUpRight />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/learn">How it works</Link>
            </Button>
          </div>
          <div className="mt-10 flex gap-8">
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
        <div className="relative flex min-w-0 items-center justify-center overflow-hidden bg-secondary px-6 py-12 md:px-10 lg:px-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-12 -bottom-12 rotate-[-20deg] opacity-5"
          >
            <Image
              src="/brand/logo.svg"
              alt=""
              width={480}
              height={480}
              unoptimized
              className="h-auto w-[480px]"
            />
          </div>
          <div className="panel relative w-full max-w-[560px] p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap justify-between gap-2 text-xs font-medium">
              <span className="eyebrow text-positive">
                {market ? `${market.lifecycle} · ${marketCategory(market)}` : "Impact markets"}
              </span>
              <span className="font-mono text-muted-foreground">
                P(YES){" "}
                {market?.probability.quality === "valid"
                  ? `${formatNumber((market.probability.value ?? 0) * 100, 0)}%`
                  : "—"}{" "}
                · Polymarket
              </span>
            </div>
            <h2 className="text-xl font-semibold leading-snug tracking-[-0.03em]">
              {market?.question ?? "How does an event change a stock’s value?"}
            </h2>
            <div className="my-5">
              <PriceChart market={market} mini />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {(["YES", "NO"] as const).map((branch) => (
                <div
                  key={branch}
                  className={`min-w-0 rounded-[10px] border p-3 ${branch === "YES" ? "border-positive bg-positive-soft text-positive" : "border-danger bg-danger-soft text-danger"}`}
                >
                  <div className="eyebrow flex flex-wrap justify-between gap-2">
                    <span>IF {branch}</span>
                    <span className="font-mono">
                      {market ? percent(impactPercent(market, branch)) : "—"} impact
                    </span>
                  </div>
                  <div className="mt-2 font-mono text-[clamp(13px,4vw,26px)] font-semibold text-foreground">
                    {formatNumber(
                      market ? midpoint(branch === "YES" ? market.yes : market.no) : null,
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="overflow-hidden border-y py-4" aria-label="Market impact ticker">
        <div className="market-ticker flex w-max">
          {[0, 1].map((repeat) => (
            <div key={repeat} className="flex shrink-0" aria-hidden={repeat === 1}>
              {markets
                .filter((m) => m.lifecycle === "open")
                .map((m) => (
                  <span key={m.id} className="flex items-center gap-4 border-r px-8 text-xs">
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
      <strong className="font-mono text-base font-medium">{value}</strong>
      <div className="mt-2 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
