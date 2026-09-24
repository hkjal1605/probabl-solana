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
import { positionHasClaims } from "@/services/index-stream";
import type { MarketView, PositionView } from "@/types/api";

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
    (p) => markets.some((m) => m.id === p.marketId) && positionHasClaims(p),
  );
  if (!rows.length) return <EmptyState>No indexed conditional claims yet.</EmptyState>;
  if (variant === "portfolio")
    return (
      <ul className="flex list-none flex-col gap-2" aria-label="Conditional claims">
        {rows.map((position) => {
          const market = markets.find((m) => m.id === position.marketId);
          if (!market) return null;
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
                {claimLines(market, position).flatMap((line) =>
                  (["YES", "NO"] as const).map((branch) => (
                    <div key={`${line.collateral}-${branch}`}>
                      <p className="tabular-nums font-medium">
                        {formatNumber(
                          tokenAmount(branch === "YES" ? line.yes : line.no, line.decimals),
                          line.collateral === 0 ? 2 : 4,
                        )}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {line.symbol} {branch}
                      </p>
                    </div>
                  )),
                )}
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
          <TableHead>Claim token</TableHead>
          <TableHead>YES</TableHead>
          <TableHead>NO</TableHead>
          <TableHead>
            <span className="sr-only">Manage claims</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.flatMap((position) => {
          const market = markets.find((m) => m.id === position.marketId);
          if (!market) return [];
          return claimLines(market, position).map((line) => (
            <TableRow key={`${position.marketId}-${line.collateral}`}>
              <TableCell className="font-semibold">{market.ticker}</TableCell>
              <TableCell>
                {line.symbol}
                {line.issuer && <p className="mt-1 text-xs text-muted-foreground">{line.issuer}</p>}
              </TableCell>
              {(
                [
                  ["yes", line.yes],
                  ["no", line.no],
                ] as const
              ).map(([branch, amount]) => (
                <TableCell key={branch} className="tabular-nums">
                  {formatNumber(tokenAmount(amount, line.decimals), line.collateral === 0 ? 2 : 4)}
                </TableCell>
              ))}
              <TableCell className="text-right">
                <PositionActions
                  position={position}
                  market={market}
                  collateral={line.collateral}
                  disabled={!query.isDataFresh}
                />
              </TableCell>
            </TableRow>
          ));
        })}
      </TableBody>
    </Table>
  );
}

/** Quote claims plus every issuer leg's own claims, in raw units of each claim mint. */
export function claimLines(market: MarketView, position: PositionView, includeEmpty = false) {
  const lines = [
    {
      collateral: 0,
      symbol: market.quoteTokenMetadata?.symbol ?? "USDC",
      issuer: null as string | null,
      decimals: position.quoteTokenDecimals,
      yes: position.quoteYes,
      no: position.quoteNo,
    },
    ...market.bases.map((leg) => {
      const held = position.bases.find((item) => item.collateral === leg.collateral);
      return {
        collateral: leg.collateral,
        symbol: leg.symbol,
        issuer: leg.issuer,
        decimals: held?.decimals ?? leg.decimals,
        yes: held?.yes ?? "0",
        no: held?.no ?? "0",
      };
    }),
  ];
  return includeEmpty
    ? lines
    : lines.filter((line) => BigInt(line.yes) > 0n || BigInt(line.no) > 0n);
}
