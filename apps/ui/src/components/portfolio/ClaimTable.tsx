"use client";
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

export function ClaimTable({
  markets,
  variant = "table",
}: {
  markets: MarketView[];
  variant?: "table" | "portfolio";
}) {
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
  if (query.isPending) return <LoadingState />;
  const rows = query.positions.filter(
    (p) =>
      markets.some((m) => m.id === p.marketId) &&
      [p.stockYes, p.stockNo, p.quoteYes, p.quoteNo].some((amount) => BigInt(amount) > 0n),
  );
  if (!rows.length) return <EmptyState>No indexed conditional claims yet.</EmptyState>;
  if (variant === "portfolio")
    return (
      <ul className="flex list-none flex-col gap-2" aria-label="Conditional claims">
        {rows.map((position) => {
          const market = markets.find((m) => m.id === position.marketId);
          if (!market) return null;
          const values = [
            ["Stock YES", position.stockYes, position.baseTokenDecimals],
            ["Stock NO", position.stockNo, position.baseTokenDecimals],
            ["Cash YES", position.quoteYes, position.quoteTokenDecimals],
            ["Cash NO", position.quoteNo, position.quoteTokenDecimals],
          ] as const;
          return (
            <li
              className="flex flex-col gap-4 rounded-xl bg-card px-4 py-3 lg:flex-row lg:items-center"
              key={position.marketId}
            >
              <div className="min-w-0 lg:w-64 lg:shrink-0">
                <p className="font-medium">{market.ticker}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{market.question}</p>
              </div>
              <div className="grid flex-1 grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                {values.map(([label, amount, decimals]) => (
                  <div key={label}>
                    <p className="tabular-nums font-medium">
                      {formatNumber(tokenAmount(amount, decimals), decimals === 6 ? 2 : 4)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
              <PositionActions position={position} market={market} disabled={!query.isDataFresh} />
            </li>
          );
        })}
      </ul>
    );
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
                <TableCell key={key} className="tabular-nums">
                  {formatNumber(
                    tokenAmount(
                      position[key],
                      index < 2 ? position.baseTokenDecimals : position.quoteTokenDecimals,
                    ),
                    index < 2 ? 4 : 2,
                  )}
                </TableCell>
              ))}
              <TableCell className="text-right">
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
  );
}
