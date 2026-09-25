"use client";

import { WalletCards } from "lucide-react";
import Link from "next/link";
import { useWallet } from "@/components/providers/WalletProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataError, EmptyState, Page } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { useWalletLogin } from "@/components/wallet/WalletLoginProvider";
import { useMarkets, useOrders, usePositions, useTrades } from "@/hooks/useProtocolData";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { formatCompactNumber, formatNumber, tokenAmount } from "@/lib/format/display";
import { groupMarkets, sortEventGroups } from "@/lib/markets/presentation";
import { walletTradeRows } from "@/lib/portfolio/presentation";
import { positionHasClaims } from "@/services/index-stream";
import type { MarketView } from "@/types/api";
import { PortfolioEventCard } from "./PortfolioEventCard";
import { PortfolioEventSkeleton } from "./PortfolioEventSkeleton";
import { PortfolioTradeHistory } from "./PortfolioTradeHistory";
import { PortfolioVault } from "./PortfolioVault";
import { TradingPermissionCard } from "./TradingPermissionCard";

const hasClaims = positionHasClaims;

export function PortfolioClient({ markets: initial }: { markets: MarketView[] }) {
  const wallet = useWallet();
  const login = useWalletLogin();
  const marketQuery = useMarkets(initial);
  const { markets } = marketQuery;
  const ordersQuery = useOrders();
  const positionsQuery = usePositions();
  const tradesQuery = useTrades();
  const assetQuery = useWalletAssets(markets);
  const activeOrders = ordersQuery.orders.filter((order) => order.status === "open");
  const balances = assetQuery.balances
    .map((asset) => {
      const vault = BigInt(asset.balance.vaultAvailable);
      const walletAmount = BigInt(asset.balance.canonicalBalance);
      const reserved = BigInt(asset.balance.reserved);
      return { ...asset, vault, walletAmount, reserved, available: vault };
    })
    .filter((asset) => asset.available > 0n || asset.walletAmount > 0n || asset.reserved > 0n);
  const claims = positionsQuery.positions.filter(hasClaims);
  const valuesKnown =
    assetQuery.isDataFresh &&
    marketQuery.isDataFresh &&
    balances.every((asset) => asset.available === 0n || asset.reference !== null);
  const total = valuesKnown
    ? balances.reduce(
        (sum, asset) =>
          sum + tokenAmount(asset.available.toString(), asset.decimals) * (asset.reference ?? 0),
        0,
      )
    : null;
  const relevantMarketIds = new Set([
    ...ordersQuery.orders.map((order) => order.marketId),
    ...positionsQuery.positions.filter(hasClaims).map((position) => position.marketId),
  ]);
  const eventGroups = sortEventGroups(
    groupMarkets(markets).filter((group) =>
      group.some((market) => relevantMarketIds.has(market.id)),
    ),
    "newest",
  );
  const claimEvents = eventGroups.filter((group) => {
    const ids = new Set(group.map((market) => market.id));
    return claims.some((position) => ids.has(position.marketId));
  }).length;
  const tradeRows = walletTradeRows(tradesQuery.trades, ordersQuery.orders, markets);
  const eventsPending = marketQuery.isPending || ordersQuery.isPending || positionsQuery.isPending;
  const tradesPending = eventsPending || tradesQuery.isPending;

  return (
    <Page className="page-scrollbars-hidden max-w-[1280px] px-5 py-8 sm:px-6 sm:py-10">
      {!wallet.account ? (
        <div className="flex min-h-[60dvh] items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-card text-muted-foreground">
              <WalletCards className="size-5" />
            </span>
            <div>
              <h1 className="text-xl font-medium">Your portfolio</h1>
              <p className="mt-2 text-sm font-medium text-muted-foreground">
                Connect your wallet to view balances, event positions, claims, and fills.
              </p>
            </div>
            <Button onClick={login}>Connect wallet</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-4xl font-medium tracking-tight sm:text-[40px] sm:leading-11">
                Portfolio
              </h1>
              {ordersQuery.isPending || positionsQuery.isPending ? (
                <Skeleton className="mt-2 h-5 w-56" aria-label="Loading portfolio summary" />
              ) : (
                <p className="mt-2 text-sm font-medium text-muted-foreground">
                  {claimEvents} {claimEvents === 1 ? "event" : "events"} with claims ·{" "}
                  {activeOrders.length} open {activeOrders.length === 1 ? "order" : "orders"}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="lg"
                onClick={() =>
                  document
                    .getElementById("portfolio-events")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
                disabled={!eventGroups.length}
              >
                View claims
              </Button>
              <Button size="lg" render={<Link href="/" />} nativeButton={false}>
                Explore markets
              </Button>
            </div>
          </header>

          {(marketQuery.isInitialError ||
            ordersQuery.isInitialError ||
            positionsQuery.isInitialError ||
            tradesQuery.isInitialError) && (
            <DataError
              message="Some portfolio data is temporarily unavailable."
              retry={() => {
                void marketQuery.refetch();
                void ordersQuery.refetch();
                void positionsQuery.refetch();
                void tradesQuery.refetch();
              }}
            />
          )}

          <Card variant="panel" className="rounded-xl bg-card">
            <CardContent className="grid gap-7 px-0 py-7 lg:min-h-[150px] lg:grid-cols-[220px_minmax(0,1fr)] lg:items-center">
              <div>
                <p className="eyebrow uppercase tracking-[0.12em] font-semibold text-muted-foreground">
                  Total balance
                </p>
                {assetQuery.isPending && balances.length === 0 ? (
                  <Skeleton className="mt-2 h-11 w-40" aria-label="Loading total balance" />
                ) : (
                  <p className="mt-2 text-3xl font-medium tracking-tight tabular-nums sm:text-[40px] sm:leading-11">
                    {total === null ? "—" : `$${formatNumber(total, 2)}`}
                  </p>
                )}
                <p className="mt-2 text-xs font-medium text-muted-foreground">
                  Available in vault · estimated value
                </p>
              </div>
              {assetQuery.isInitialError ? (
                <DataError
                  message="Token balances are unavailable."
                  retry={() => void assetQuery.refetch()}
                />
              ) : assetQuery.isPending && balances.length === 0 ? (
                <div
                  role="status"
                  aria-label="Loading token balances"
                  className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4 lg:grid-cols-7"
                >
                  {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} aria-hidden="true" className="flex flex-col gap-2">
                      <Skeleton className="h-5 w-12" />
                      <Skeleton className="h-7 w-20" />
                    </div>
                  ))}
                </div>
              ) : balances.length === 0 ? (
                <p className="text-sm font-medium text-muted-foreground">Deposit tokens to start trading.</p>
              ) : (
                <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4 lg:grid-cols-7">
                  {balances
                    .filter((asset) => asset.available > 0n)
                    .map((asset) => (
                      <div key={asset.token} className="min-w-0">
                        <dt className="text-sm font-semibold text-muted-foreground">
                          {asset.symbol}
                        </dt>
                        <dd className="mt-2 truncate text-lg font-medium tabular-nums">
                          {formatCompactNumber(
                            tokenAmount(asset.available.toString(), asset.decimals),
                          )}
                        </dd>
                      </div>
                    ))}
                </dl>
              )}
            </CardContent>
          </Card>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <PortfolioVault
              assets={assetQuery.assets}
              balances={assetQuery.balances}
              fresh={assetQuery.isDataFresh}
              refresh={assetQuery.refetch}
            />
            <TradingPermissionCard />
          </div>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section id="portfolio-events" className="flex min-w-0 flex-col gap-5">
              {eventGroups.length === 0 && eventsPending ? (
                <>
                  <PortfolioEventSkeleton />
                  <PortfolioEventSkeleton />
                </>
              ) : eventGroups.length === 0 ? (
                <Card variant="panel" className="rounded-xl bg-card">
                  <EmptyState>No event positions, orders, or claims yet.</EmptyState>
                </Card>
              ) : (
                eventGroups.map((group) => (
                  <PortfolioEventCard
                    key={group[0]?.mapping.conditionId ?? group[0]?.id}
                    markets={group}
                    orders={ordersQuery.orders}
                    positions={positionsQuery.positions}
                  />
                ))
              )}
            </section>
            <PortfolioTradeHistory rows={tradeRows} isPending={tradesPending} />
          </div>
        </div>
      )}
    </Page>
  );
}
