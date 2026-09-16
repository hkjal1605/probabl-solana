"use client";

import BoringAvatar from "boring-avatars";
import { WalletCards } from "lucide-react";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { ClaimTable } from "@/components/portfolio/ClaimTable";
import { PositionTable } from "@/components/portfolio/PositionTable";
import { useWallet } from "@/components/providers/WalletProvider";
import { Button } from "@/components/ui/button";
import { DataError, EmptyState, Page } from "@/components/ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMarkets, useOrders, usePositions } from "@/hooks/useProtocolData";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { formatCompactNumber, formatNumber, shortAddress, tokenAmount } from "@/lib/format/display";
import type { MarketView } from "@/types/api";
import { PendingPayouts } from "./PendingPayouts";

const vaultAvailable = (creditBalances?: Record<string, string>) =>
  Object.values(creditBalances ?? {}).reduce((sum, amount) => sum + BigInt(amount), 0n);

export function PortfolioClient({ markets: initial }: { markets: MarketView[] }) {
  const wallet = useWallet();
  const marketQuery = useMarkets(initial);
  const { markets } = marketQuery;
  const ordersQuery = useOrders();
  const positionsQuery = usePositions();
  const assetQuery = useWalletAssets(markets);
  const activeOrders = ordersQuery.orders.filter((order) => order.status === "open");
  const balances = assetQuery.balances
    .map((asset) => {
      const vault = vaultAvailable(asset.balance.creditBalances);
      const walletAmount = BigInt(asset.balance.canonicalBalance);
      return { ...asset, vault, walletAmount, available: walletAmount + vault };
    })
    .filter((asset) => asset.available > 0n);
  const positions = positionsQuery.positions.filter((position) =>
    [position.stockYes, position.stockNo].some((amount) => BigInt(amount) > 0n),
  );
  const claims = positionsQuery.positions.filter((position) =>
    [position.stockYes, position.stockNo, position.quoteYes, position.quoteNo].some(
      (amount) => BigInt(amount) > 0n,
    ),
  );
  const valuesKnown =
    balances.length > 0 &&
    assetQuery.isDataFresh &&
    marketQuery.isDataFresh &&
    balances.every((asset) => asset.reference !== null);
  const total = valuesKnown
    ? balances.reduce(
        (sum, asset) =>
          sum + tokenAmount(asset.available.toString(), asset.decimals) * (asset.reference ?? 0),
        0,
      )
    : null;
  const allocation =
    total && total > 0
      ? balances
          .map((asset) => ({
            symbol: asset.symbol,
            share:
              (tokenAmount(asset.available.toString(), asset.decimals) * (asset.reference ?? 0)) /
              total,
          }))
          .filter((asset) => asset.share > 0)
          .sort((a, b) => b.share - a.share)
      : [];
  let allocationOffset = 0;
  const allocationBackground = allocation.length
    ? `conic-gradient(${allocation
        .map((asset, index) => {
          const start = allocationOffset;
          allocationOffset += asset.share * 100;
          return `var(--chart-${(index % 5) + 1}) ${start}% ${allocationOffset}%`;
        })
        .join(", ")})`
    : undefined;

  return (
    <Page className="max-w-[1120px] py-8 sm:px-6 sm:py-10">
      {!wallet.account ? (
        <div className="flex min-h-[60dvh] items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-card text-muted-foreground">
              <WalletCards className="size-5" />
            </span>
            <div>
              <h1 className="text-xl font-medium">Your portfolio</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Connect your wallet to view tokens, positions, and claims.
              </p>
            </div>
            <Button onClick={() => wallet.connect().catch(() => undefined)}>Connect wallet</Button>
          </div>
        </div>
      ) : (
        <>
          <header className="mb-10">
            <div className="flex items-center gap-2">
              <span
                className="flex size-8 shrink-0 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <BoringAvatar name={wallet.account} variant="beam" size={32} />
              </span>
              <p className="text-base font-semibold text-foreground">
                {shortAddress(wallet.account, 6)}
              </p>
            </div>
            <div className="mt-4 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total worth</p>
                <h1 className="mt-1 text-4xl font-medium tracking-tight tabular-nums sm:text-5xl">
                  {total === null ? "—" : `$${formatNumber(total, 2)}`}
                </h1>
                {total === null && balances.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    A current reference price is unavailable for one or more tokens.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-7 sm:flex-row sm:items-center">
                <dl className="grid grid-cols-2 gap-x-10 gap-y-5 sm:grid-cols-4">
                  <PortfolioStat label="Tokens" value={balances.length} />
                  <PortfolioStat label="Open positions" value={positions.length} />
                  <PortfolioStat label="Open orders" value={activeOrders.length} />
                  <PortfolioStat label="Claim markets" value={claims.length} />
                </dl>
                {allocationBackground && allocation[0] && (
                  <div
                    role="img"
                    className="relative hidden size-24 shrink-0 rounded-full lg:block"
                    style={{ background: allocationBackground }}
                    aria-label={`${allocation[0].symbol} is ${formatNumber(allocation[0].share * 100, 0)}% of available token value`}
                  >
                    <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-background">
                      <strong className="text-sm font-medium">{allocation[0].symbol}</strong>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatNumber(allocation[0].share * 100, 0)}%
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          {(marketQuery.isInitialError ||
            ordersQuery.isInitialError ||
            positionsQuery.isInitialError) && (
            <div className="mb-5">
              <DataError
                message="Some portfolio data is temporarily unavailable."
                retry={() => {
                  void marketQuery.refetch();
                  void ordersQuery.refetch();
                  void positionsQuery.refetch();
                }}
              />
            </div>
          )}

          <Tabs defaultValue="tokens" className="gap-6">
            <div className="w-fit max-w-full overflow-hidden rounded-lg bg-card px-1 py-1">
              <TabsList
                aria-label="Portfolio views"
                className="h-7 max-w-full gap-1 overflow-hidden border-0 bg-transparent p-0"
              >
                <TabsTrigger className="h-7 flex-none px-3" value="tokens">
                  Tokens
                </TabsTrigger>
                <TabsTrigger className="h-7 flex-none px-3" value="positions">
                  Open positions
                </TabsTrigger>
                <TabsTrigger className="h-7 flex-none px-3" value="claims">
                  Claims
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="tokens">
              {assetQuery.isInitialError ? (
                <DataError
                  message="Token balances are unavailable."
                  retry={() => void assetQuery.refetch()}
                />
              ) : balances.length === 0 ? (
                <EmptyState>No supported token balances yet.</EmptyState>
              ) : (
                <ul className="flex list-none flex-col gap-2" aria-label="Token balances">
                  {balances.map((asset) => {
                    const amount = tokenAmount(asset.available.toString(), asset.decimals);
                    return (
                      <li
                        key={asset.token}
                        className="flex min-h-16 items-center justify-between gap-5 rounded-xl bg-card px-4 py-3"
                      >
                        <TokenIdentity
                          symbol={asset.symbol}
                          metadata={asset.metadata}
                          textSize="lg"
                        />
                        <div className="min-w-0 text-right">
                          <p className="text-base font-medium tabular-nums">
                            {formatCompactNumber(amount)} {asset.symbol}
                          </p>
                          {asset.vault > 0n && (
                            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                              {formatCompactNumber(
                                tokenAmount(asset.vault.toString(), asset.decimals),
                              )}{" "}
                              {asset.symbol} in vault
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="positions">
              <PositionTable markets={markets} variant="portfolio" />
            </TabsContent>

            <TabsContent value="claims">
              <div className="flex flex-col gap-8">
                <ClaimTable markets={markets} variant="portfolio" />
                <PendingPayouts markets={markets} />
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </Page>
  );
}

function PortfolioStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-24">
      <dd className="text-xl font-medium tabular-nums">{value}</dd>
      <dt className="mt-1 text-xs text-muted-foreground">{label}</dt>
    </div>
  );
}
