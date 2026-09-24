"use client";

import { ArrowDownToLine } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMarketCatalogue } from "@/hooks/useMarketCatalogue";
import { useOrders } from "@/hooks/useProtocolData";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { formatCompactUsd } from "@/lib/format/display";
import { headerPortfolioSummary } from "@/lib/portfolio/summary";
import { DepositDialog } from "./DepositDialog";
import { WalletButton } from "./WalletButton";

const formatHeaderUsd = (value: number) => (value === 0 ? "$0.00" : formatCompactUsd(value));

export function HeaderAccountControls() {
  const wallet = useWallet();
  const catalogue = useMarketCatalogue();
  const assets = useWalletAssets(catalogue.markets);
  const orders = useOrders();
  const [depositOpen, setDepositOpen] = useState(false);
  const balancesFresh = assets.isDataFresh && !catalogue.error;
  const valuationFresh = balancesFresh && orders.isDataFresh && orders.data?.openTruncated !== true;
  const balancesLoading = assets.isPending || catalogue.loading;
  const valuationLoading = balancesLoading || orders.isPending;
  const summary = headerPortfolioSummary(
    catalogue.markets,
    assets.balances,
    assets.positions,
    orders.orders,
  );

  if (!wallet.account) return <WalletButton />;
  return (
    <>
      <div className="flex items-center gap-5">
        <div className="hidden items-center gap-5 xl:flex">
          <Link
            href="/portfolio"
            className="flex flex-col items-end gap-1 text-right leading-none"
            title="Net portfolio value"
          >
            <span className="text-xs font-medium text-muted-foreground">Portfolio</span>
            {valuationLoading ? (
              <Skeleton className="h-3.5 w-14" aria-label="Loading portfolio value" />
            ) : (
              <span className="text-sm font-medium tabular-nums text-positive">
                {valuationFresh && summary.netPortfolioValue !== null
                  ? formatHeaderUsd(summary.netPortfolioValue)
                  : "$0.00"}
              </span>
            )}
          </Link>
          <div
            className="flex flex-col items-end gap-1 text-right leading-none"
            title="Cash available to trade"
          >
            <span className="text-xs font-medium text-muted-foreground">Cash</span>
            {balancesLoading ? (
              <Skeleton className="h-3.5 w-14" aria-label="Loading available cash" />
            ) : (
              <span className="text-sm font-medium tabular-nums text-positive">
                {balancesFresh ? formatHeaderUsd(summary.cashAvailable) : "$0.00"}
              </span>
            )}
          </div>
        </div>
        <Button
          size="sm"
          className="hidden rounded-lg px-3 sm:inline-flex"
          onClick={() => setDepositOpen(true)}
        >
          <ArrowDownToLine data-icon="inline-start" />
          Deposit
        </Button>
        <WalletButton />
      </div>
      <DepositDialog
        open={depositOpen}
        onOpenChange={setDepositOpen}
        assets={assets.assets}
        balances={assets.balances}
        fresh={balancesFresh}
        refresh={assets.refetch}
      />
    </>
  );
}
