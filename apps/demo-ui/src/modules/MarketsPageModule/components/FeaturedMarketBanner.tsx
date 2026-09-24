"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatSpotUsd } from "@/components/market/SpotReference";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCompactUsd, formatNumber, formatProbability } from "@/lib/format/display";
import {
  currentSpotUsd,
  type MarketCategory,
  marketCategory,
  midpoint,
  percent,
  spotImpactPercent,
} from "@/lib/markets/presentation";
import { cn } from "@/lib/utils";
import type { MarketView } from "@/types/api";
import { FEATURED_MARKET_IMAGES } from "../featured-markets";

// Temporarily hide the right-side asset cards without removing their implementation.
const SHOW_FEATURED_ASSETS = false;
const FADE_DURATION_MS = 500;

interface BannerSelection {
  category: MarketCategory;
  imageSrc: string;
  key: string;
  markets: MarketView[];
}

const resolutionDate = (cutoff: string) => {
  const date = new Date(cutoff);
  return Number.isNaN(date.getTime())
    ? "Resolution pending"
    : `Resolves ${new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(date)}`;
};

function FeaturedAsset({ market }: { market: MarketView }) {
  const spot = currentSpotUsd(market);
  const outcomes = (["YES", "NO"] as const).map((branch) => ({
    branch,
    impact: spotImpactPercent(market, branch),
    price: midpoint(branch === "YES" ? market.yes : market.no),
  }));
  return (
    <Link
      href={`/markets/${market.id}`}
      className="group flex min-h-24 flex-col justify-between rounded-xl bg-background/75 p-4 transition-colors hover:bg-background"
      aria-label={`Trade ${market.ticker} for ${market.question}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-base font-medium text-foreground">{market.ticker}</span>
        <span className="text-sm font-medium text-foreground tabular-nums">
          {spot === null ? "—" : formatSpotUsd(spot)}
        </span>
      </div>
      <dl className="mt-3 flex flex-col gap-1.5 text-xs tabular-nums">
        {outcomes.map(({ branch, impact, price }) => (
          <div key={branch} className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{branch}</dt>
            <dd className="flex items-center gap-2 text-right font-medium">
              <span className="text-foreground">{formatNumber(price)}</span>
              <span
                className={cn(
                  "min-w-12",
                  impact === null
                    ? "text-muted-foreground"
                    : impact >= 0
                      ? "text-positive"
                      : "text-destructive",
                )}
              >
                {percent(impact)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}

function FeaturedMarketCard({ selection }: { selection: BannerSelection }) {
  const { category, imageSrc, markets } = selection;
  const market = markets[0];
  if (!market) return null;
  const liquidity = markets.reduce((sum, asset) => sum + asset.yes.depthUsd + asset.no.depthUsd, 0);

  return (
    <Card className="relative mb-6 overflow-hidden rounded-xl bg-overlay py-0 text-white ring-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 left-[20%]"
        style={{
          maskImage: "linear-gradient(to right, transparent 0%, black 18%, black 100%)",
          WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 18%, black 100%)",
        }}
      >
        <Image
          src={imageSrc}
          alt=""
          fill
          priority={category === "All"}
          unoptimized
          sizes="80vw"
          className="object-cover object-[center_42%] opacity-55"
        />
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-linear-to-b from-overlay/35 via-transparent to-overlay/50"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-xl bg-linear-to-r from-border via-border/50 to-transparent p-px"
        style={{
          mask: "linear-gradient(black 0 0) content-box, linear-gradient(black 0 0)",
          maskComposite: "exclude",
          WebkitMask: "linear-gradient(black 0 0) content-box, linear-gradient(black 0 0)",
          WebkitMaskComposite: "xor",
        }}
      />
      <CardContent className="relative grid gap-8 px-6 py-7 sm:px-8 sm:py-9 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] lg:items-center lg:gap-12">
        <div className="flex min-w-0 flex-col items-start">
          <p className="text-xs font-medium uppercase tracking-[0.1em] text-primary">
            Featured market · {category === "All" ? marketCategory(market) : category}
          </p>
          <h1 className="mt-4 max-w-2xl text-3xl font-medium tracking-tight text-white sm:text-4xl">
            {market.question}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-white/60">
            <span className="tabular-nums">
              Probability {formatProbability(market.probability.value)}
            </span>
            <span>{resolutionDate(market.cutoff)}</span>
            <span className="tabular-nums">
              {liquidity > 0 ? `${formatCompactUsd(liquidity)} liquidity` : "Liquidity building"}
            </span>
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <Button size="lg" render={<Link href={`/markets/${market.id}`} />} nativeButton={false}>
              Trade {market.ticker} if YES
            </Button>
            <Link
              href={`/markets/${market.id}`}
              className="text-sm font-medium text-white underline decoration-white/40 underline-offset-4"
            >
              All {markets.length} assets
            </Link>
          </div>
        </div>
        {SHOW_FEATURED_ASSETS && (
          <div className="grid gap-2 sm:grid-cols-2">
            {markets.map((asset) => (
              <FeaturedAsset key={asset.id} market={asset} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FeaturedMarketBanner({
  category,
  imageSrc,
  markets,
}: {
  category: MarketCategory;
  imageSrc: string;
  markets: MarketView[];
}) {
  const market = markets[0];
  const selection = useMemo<BannerSelection>(
    () => ({
      category,
      imageSrc,
      key: `${category}:${market?.mapping.conditionId ?? market?.id ?? "empty"}`,
      markets,
    }),
    [category, imageSrc, market?.id, market?.mapping.conditionId, markets],
  );
  const currentRef = useRef(selection);
  const latestSelectionRef = useRef(selection);
  latestSelectionRef.current = selection;
  const transitionKey = selection.key;
  const [current, setCurrent] = useState(selection);
  const [previous, setPrevious] = useState<BannerSelection | null>(null);
  const [entered, setEntered] = useState(true);

  useEffect(() => {
    for (const source of FEATURED_MARKET_IMAGES) {
      const preload = new window.Image();
      preload.decoding = "async";
      preload.src = source;
    }
  }, []);

  useLayoutEffect(() => {
    const next = latestSelectionRef.current;
    if (next.key !== transitionKey) return;
    const outgoing = currentRef.current;
    currentRef.current = next;
    if (outgoing.key === next.key) {
      setCurrent(next);
      return;
    }

    setPrevious(outgoing);
    setCurrent(next);
    setEntered(false);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setEntered(true));
    });
    const cleanup = window.setTimeout(() => setPrevious(null), FADE_DURATION_MS);
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      clearTimeout(cleanup);
    };
  }, [transitionKey]);

  useEffect(() => {
    if (selection.key !== currentRef.current.key) return;
    currentRef.current = selection;
    setCurrent(selection);
  }, [selection]);

  return (
    <div className="relative grid" data-slot="featured-market-transition">
      {previous && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none col-start-1 row-start-1 transition-opacity duration-500 ease-out motion-reduce:transition-none",
            entered ? "opacity-0" : "opacity-100",
          )}
        >
          <FeaturedMarketCard selection={previous} />
        </div>
      )}
      <div
        className={cn(
          "col-start-1 row-start-1 transition-opacity duration-500 ease-out motion-reduce:transition-none",
          entered ? "opacity-100" : "opacity-0",
        )}
      >
        <FeaturedMarketCard selection={current} />
      </div>
    </div>
  );
}
