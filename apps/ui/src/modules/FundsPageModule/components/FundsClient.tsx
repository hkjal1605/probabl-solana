"use client";

import { useWallet } from "@/components/providers/WalletProvider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page";
import { useWalletLogin } from "@/components/wallet/WalletLoginProvider";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { PortfolioVault } from "@/modules/PortfolioPageModule/components/PortfolioVault";
import { TradingPermissionCard } from "@/modules/PortfolioPageModule/components/TradingPermissionCard";
import type { MarketView } from "@/types/api";

export function FundsClient({ markets }: { markets: MarketView[] }) {
  const wallet = useWallet();
  const login = useWalletLogin();
  const assets = useWalletAssets(markets);
  if (!wallet.account) return <EmptyState>
    <p>Connect a wallet to manage deposited tokens.</p>
    <Button onClick={login}>Connect wallet</Button>
  </EmptyState>;
  return <div className="mx-auto grid max-w-[1120px] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
    <PortfolioVault assets={assets.assets} balances={assets.balances}
      fresh={assets.isDataFresh} refresh={assets.refetch} />
    <TradingPermissionCard />
  </div>;
}
