"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import { Tabs, TabsContent } from "@conditional-stocks/ui-kit/tabs";
import { ArrowDownToLine, ArrowUpRight, Download } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { ClaimTable } from "@/components/portfolio/ClaimTable";
import { PositionTable } from "@/components/portfolio/PositionTable";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { useWallet } from "@/components/providers/WalletProvider";
import {
  LineTabsList as TabsList,
  LineTabsTrigger as TabsTrigger,
} from "@/components/ui/line-tabs";
import { DataError, EmptyState, Page, PageHeading } from "@/components/ui/page";
import { useMarkets, useOrders, usePositions } from "@/hooks/useProtocolData";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import type { IndexedOrder, MarketView } from "@/lib/api/types";
import { formatNumber, shortAddress, tokenAmount } from "@/lib/format/display";
import { groupMarkets } from "@/lib/markets/presentation";
import { orderHistoryCsv, wholeReserved } from "@/lib/portfolio/presentation";
import { OrdersClient } from "@/modules/OrdersPageModule/components/OrdersClient";
import { PendingPayouts } from "./PendingPayouts";
import { RefreshStatus } from "@/components/data/RefreshStatus";

export function PortfolioClient({ markets: initial }: { markets: MarketView[] }) {
  const wallet = useWallet(),
    marketQuery = useMarkets(initial);
  const { markets } = marketQuery,
    ordersQuery = useOrders(),
    positionsQuery = usePositions(),
    assetQuery = useWalletAssets(markets);
  const setFunds = useUiStore((s) => s.setFunds);
  const groups = groupMarkets(markets),
    activeOrders = ordersQuery.orders.filter((o) => o.status === "open");
  const exposures = groups.filter((assets) =>
    assets.some((m) =>
      positionsQuery.positions.some(
        (p) =>
          p.marketId === m.id &&
          [p.stockYes, p.stockNo, p.quoteYes, p.quoteNo].some((v) => BigInt(v) > 0n),
      ),
    ),
  ).length;
  const balances = assetQuery.balances.map((asset) => ({
    ...asset,
    reserved: wholeReserved(asset.token, activeOrders, markets),
  }));
  const known =
    Boolean(
      !assetQuery.isPending &&
        !assetQuery.isInitialError &&
        !ordersQuery.isPending &&
        !ordersQuery.isInitialError &&
        !ordersQuery.data?.openTruncated &&
        !marketQuery.isInitialError,
    ) && balances.length > 0;
  const total =
    known &&
    assetQuery.isDataFresh &&
    ordersQuery.isDataFresh &&
    marketQuery.isDataFresh &&
    balances.every(
      (a) => a.reference !== null || BigInt(a.balance.canonicalBalance) + a.reserved === 0n,
    )
      ? balances.reduce(
          (sum, a) =>
            sum +
            tokenAmount((BigInt(a.balance.canonicalBalance) + a.reserved).toString(), a.decimals) *
              (a.reference ?? 0),
          0,
        )
      : null;
  return (
    <Page>
      <PageHeading
        title="Portfolio"
        description={
          wallet.account
            ? `${exposures} events with claims · ${activeOrders.length} open orders`
            : "Your positions, orders, and claims in one place."
        }
      >
        {wallet.account && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setFunds("Withdraw")}>
              <ArrowUpRight />
              Withdraw
            </Button>
            <Button variant="brand" onClick={() => setFunds("Deposit")}>
              <ArrowDownToLine />
              Deposit
            </Button>
          </div>
        )}
      </PageHeading>
      {!wallet.account ? (
        <section className="panel">
          <EmptyState>
            <p>Connect your wallet to see positions.</p>
            <Button variant="brand" onClick={() => wallet.connect().catch(() => undefined)}>
              Connect wallet
            </Button>
          </EmptyState>
        </section>
      ) : (
        <>
          <RefreshStatus
            active={
              marketQuery.isRefreshError ||
              assetQuery.isRefreshError ||
              ordersQuery.isRefreshError ||
              positionsQuery.isRefreshError
            }
            label="portfolio data"
          />
          {marketQuery.isInitialError && (
            <DataError
              message="Market metadata is unavailable. Asset totals may be incomplete."
              retry={() => {
                void marketQuery.refetch();
              }}
            />
          )}
          {(ordersQuery.isInitialError || positionsQuery.isInitialError) && (
            <DataError
              message="Some holdings or order reservations could not be loaded."
              retry={() => {
                void ordersQuery.refetch();
                void positionsQuery.refetch();
              }}
            />
          )}
          <section
            className="panel mb-6 flex flex-col divide-y lg:flex-row lg:divide-x lg:divide-y-0"
            aria-label="Wallet balances"
          >
            <div className="flex shrink-0 flex-col gap-2 p-6 lg:min-w-64">
              <span className="eyebrow">Total balance</span>
              <strong className="font-mono text-3xl tracking-tight">
                {total === null ? "—" : `$${formatNumber(total)}`}
              </strong>
              <span className="text-xs font-medium text-muted-foreground">
                Whole assets · estimated value
              </span>
              {total === null && known && (
                <span className="max-w-52 text-xs text-muted-foreground">
                  A fresh price or verified token-unit valuation is unavailable.
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-wrap gap-x-10 gap-y-5 p-6">
              {balances.map((a) => (
                <div className="min-w-28 space-y-2" key={a.token}>
                  <div className="eyebrow">{a.symbol}</div>
                  <div className="font-mono text-xl">
                    {known
                      ? formatNumber(
                          tokenAmount(
                            (BigInt(a.balance.canonicalBalance) + a.reserved).toString(),
                            a.decimals,
                          ),
                          a.symbol === "USDC" ? 2 : 4,
                        )
                      : "—"}
                  </div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {formatNumber(
                      tokenAmount(a.balance.canonicalBalance, a.decimals),
                      a.symbol === "USDC" ? 2 : 4,
                    )}{" "}
                    available
                    {a.reserved > 0n && (
                      <>
                        {" "}
                        · {formatNumber(tokenAmount(a.reserved.toString(), a.decimals), 4)} reserved
                      </>
                    )}
                  </p>
                </div>
              ))}
              {assetQuery.isInitialError && (
                <DataError
                  message="Canonical wallet balances are unavailable."
                  retry={() => {
                    void assetQuery.refetch();
                  }}
                />
              )}
              {!balances.length && (
                <span className="text-sm text-muted-foreground">
                  {assetQuery.isFetching ? "Reading balances…" : "No supported assets indexed yet."}
                </span>
              )}
            </div>
          </section>
          <div className="grid items-start gap-6 min-[1101px]:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-5">
              {groups.map((assets) => (
                <MarketHoldings key={assets[0]?.id} markets={assets} orders={activeOrders} />
              ))}
              {!groups.length && (
                <section className="panel">
                  <EmptyState>No markets are indexed yet.</EmptyState>
                </section>
              )}
              <p className="text-xs font-medium leading-6 text-muted-foreground">
                Entry and mark-to-entry require a complete cost basis and are unavailable where it
                is not indexed. Branch marks are estimates in USDC, not guaranteed redemption
                values.
              </p>
              {<PendingPayouts markets={markets} />}
            </div>
            <OrderHistory
              markets={markets}
              orders={ordersQuery.orders}
              error={ordersQuery.isInitialError}
              truncated={ordersQuery.data?.truncated ?? false}
            />
          </div>
        </>
      )}
    </Page>
  );
}
function MarketHoldings({ markets, orders }: { markets: MarketView[]; orders: IndexedOrder[] }) {
  const m = markets[0];
  if (!m) return null;
  const openCount = orders.filter((o) => markets.some((asset) => asset.id === o.marketId)).length;
  return (
    <article className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-4 p-5">
        <div>
          <h2 className="text-base font-semibold leading-6">{m.question}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            <span>{markets.map((a) => a.ticker).join(" / ")}</span> ·{" "}
            <LifecycleBadge state={m.lifecycle} /> ·{" "}
            <span>
              P(YES){" "}
              {m.probability.value === null
                ? "—"
                : `${formatNumber(m.probability.value * 100, 0)}%`}{" "}
              · Polymarket
            </span>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/markets/${m.id}`}>
            Trade <ArrowUpRight />
          </Link>
        </Button>
      </div>
      <Tabs defaultValue="positions">
        <TabsList aria-label={`${m.ticker} holdings`}>
          <TabsTrigger value="positions">Positions</TabsTrigger>
          <TabsTrigger value="orders">
            Open orders <span className="font-mono text-muted-foreground">{openCount}</span>
          </TabsTrigger>
          <TabsTrigger value="claims">Claims</TabsTrigger>
        </TabsList>
        <TabsContent value="positions">
          <PositionTable markets={markets} />
        </TabsContent>
        <TabsContent value="orders">
          <OrdersClient markets={markets} marketIds={markets.map((m) => m.id)} embedded />
        </TabsContent>
        <TabsContent value="claims">
          <ClaimTable markets={markets} />
        </TabsContent>
      </Tabs>
    </article>
  );
}
function OrderHistory({
  markets,
  orders,
  error,
  truncated,
}: {
  markets: MarketView[];
  orders: IndexedOrder[];
  error: boolean;
  truncated: boolean;
}) {
  const [limit, setLimit] = useState(20);
  const rows = [...orders].sort((a, b) =>
    BigInt(a.updatedBlock) === BigInt(b.updatedBlock)
      ? b.id.localeCompare(a.id)
      : BigInt(a.updatedBlock) > BigInt(b.updatedBlock)
        ? -1
        : 1,
  );
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([orderHistoryCsv(rows, markets)], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "probabl-order-history.csv";
    anchor.click();
    // Give browsers time to acquire the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="panel overflow-hidden" aria-label="Order history">
      <div className="panel-heading">
        <h2 className="font-semibold">History</h2>
        <Button size="sm" variant="ghost" onClick={download} disabled={error || !rows.length}>
          <Download />
          CSV
        </Button>
      </div>
      <p className="border-b px-5 py-3 text-xs font-medium text-muted-foreground">
        Canonical order updates · not a complete wallet ledger
        {truncated && " · latest 1,000 orders"}
      </p>
      {error ? (
        <EmptyState>History is unavailable.</EmptyState>
      ) : !rows.length ? (
        <EmptyState>No wallet orders yet.</EmptyState>
      ) : (
        rows.slice(0, limit).map((order) => {
          const market = markets.find((m) => m.id === order.marketId);
          return (
            <div className="border-b px-5 py-4 last:border-0" key={order.id}>
              <div className="flex justify-between gap-3 text-sm font-semibold">
                <Link href={`/markets/${order.marketId}`}>
                  {order.side === 0 ? "Buy" : "Sell"} {market?.ticker ?? "Stock"}-
                  {order.branch === 0 ? "YES" : "NO"}
                </Link>
                <span className="text-muted-foreground">{order.status}</span>
              </div>
              <p className="mt-2 text-xs font-medium text-muted-foreground">
                {market
                  ? formatNumber(tokenAmount(order.filled, market.baseTokenDecimals), 4)
                  : "—"}{" "}
                filled · block {order.updatedBlock}
              </p>
              <code className="mt-1 block text-xs text-muted-foreground" title={order.id}>
                {shortAddress(order.id, 8)}
              </code>
            </div>
          );
        })
      )}
      {rows.length > limit && (
        <div className="p-4">
          <Button variant="outline" className="w-full" onClick={() => setLimit((n) => n + 20)}>
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}
