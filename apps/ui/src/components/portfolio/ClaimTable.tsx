"use client";
import { RefreshStatus } from "@/components/data/RefreshStatus";
import { useWallet } from "@/components/providers/WalletProvider";
import { DataError, EmptyState, LoadingState } from "@/components/ui/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePositions } from "@/hooks/useProtocolData";
import { formatNumber, tokenAmount } from "@/lib/format/display";
import { PositionActions } from "@/modules/PortfolioPageModule/components/PositionActions";
import type { MarketView } from "@/types/api";

export function ClaimTable({ markets }: { markets: MarketView[] }) {
  const wallet = useWallet(),
    query = usePositions();
  if (!wallet.account) return <EmptyState>Connect your wallet to see claims.</EmptyState>;
  if (query.isInitialError)
    return (
      <DataError
        retry={() => {
          void query.refetch();
        }}
        message="Claim balances are unavailable."
      />
    );
  if (query.isPending) return <LoadingState>Reading canonical claims…</LoadingState>;
  const rows = query.positions.filter((p) => markets.some((m) => m.id === p.marketId));
  if (!rows.length)
    return (
      <>
        <RefreshStatus active={query.isRefreshError} label="claims" />
        <EmptyState>No indexed conditional claims yet.</EmptyState>
      </>
    );
  return (
    <>
      <RefreshStatus active={query.isRefreshError} label="claims" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Asset</TableHead>
            <TableHead>Stock YES</TableHead>
            <TableHead>Stock NO</TableHead>
            <TableHead>Cash YES</TableHead>
            <TableHead>Cash NO</TableHead>
            <TableHead>
              <span className="sr-only">Manage claims</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((position) => {
            const market = markets.find((m) => m.id === position.marketId);
            if (!market) return null;
            return (
              <TableRow key={position.marketId}>
                <TableCell className="font-semibold">{market.ticker}</TableCell>
                {(["stockYes", "stockNo", "quoteYes", "quoteNo"] as const).map((key, index) => (
                  <TableCell key={key} className="tabular-nums text-sm">
                    {formatNumber(
                      tokenAmount(
                        position[key],
                        index < 2 ? position.baseTokenDecimals : position.quoteTokenDecimals,
                      ),
                      index < 2 ? 4 : 2,
                    )}
                  </TableCell>
                ))}
                <TableCell>
                  <PositionActions
                    position={position}
                    market={market}
                    disabled={!query.isDataFresh}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
