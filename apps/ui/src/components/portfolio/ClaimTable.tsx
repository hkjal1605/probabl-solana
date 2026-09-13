"use client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@conditional-stocks/ui-kit/table";
import { useWallet } from "@/components/providers/WalletProvider";
import { DataError, EmptyState } from "@/components/ui/page";
import { usePositions } from "@/hooks/useProtocolData";
import type { MarketView } from "@/lib/api/types";
import { formatNumber, tokenAmount } from "@/lib/format/display";
import { PositionActions } from "@/modules/PortfolioPageModule/components/PositionActions";

export function ClaimTable({ markets }: { markets: MarketView[] }) {
  const wallet = useWallet(),
    query = usePositions();
  if (!wallet.account) return <EmptyState>Connect your wallet to see claims.</EmptyState>;
  if (query.isError)
    return (
      <DataError
        retry={() => {
          void query.refetch();
        }}
        message="Claim balances are unavailable."
      />
    );
  if (query.isPending) return <EmptyState>Reading canonical claims…</EmptyState>;
  const rows = query.positions.filter((p) => markets.some((m) => m.id === p.marketId));
  if (!rows.length) return <EmptyState>No indexed conditional claims yet.</EmptyState>;
  return (
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
                <TableCell key={key} className="font-mono text-sm">
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
                <PositionActions position={position} market={market} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
