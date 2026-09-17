"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { useRouter } from "next/navigation";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { useWallet } from "@/components/providers/WalletProvider";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { DataError, EmptyState, LoadingState } from "@/components/ui/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOrders, usePositions } from "@/hooks/useProtocolData";
import { formatNumber, tokenAmount } from "@/lib/format/display";
import { midpoint } from "@/lib/markets/presentation";
import { conditionalPositionRows } from "@/lib/portfolio/positions";
import type { MarketView } from "@/types/api";

export function PositionTable({
  markets,
  inline = false,
  softClose = false,
  variant = "table",
}: {
  markets: MarketView[];
  inline?: boolean;
  softClose?: boolean;
  variant?: "table" | "portfolio";
}) {
  const wallet = useWallet(),
    positions = usePositions(),
    orders = useOrders(),
    router = useRouter();
  const setPrefill = useUiStore((s) => s.setPrefill);
  if (!wallet.account) return <EmptyState>Connect your wallet to see positions.</EmptyState>;
  if (positions.isInitialError || orders.isInitialError)
    return (
      <DataError
        retry={() => {
          void positions.refetch();
          void orders.refetch();
        }}
        message="Positions or reservations are unavailable."
      />
    );
  if (orders.data?.openTruncated)
    return (
      <EmptyState>
        The open-order limit was reached. Position totals including reservations are unavailable.
        Available wallet claims can still be managed in the Claims tab.
      </EmptyState>
    );
  if (positions.isPending || orders.isPending) return <LoadingState />;
  const rows = conditionalPositionRows(markets, positions.positions, orders.orders);
  if (!rows.length) return <EmptyState>No conditional positions in this event yet.</EmptyState>;
  if (variant === "portfolio")
    return (
      <ul className="flex list-none flex-col gap-2" aria-label="Open positions">
        {rows.map((row) => {
          const { market, branch, kind, symbol, decimals, available, reserved, total } = row;
          const mark = kind === "stock" ? midpoint(branch === 0 ? market.yes : market.no) : null;
          return (
            <li
              className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl bg-card px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(7rem,.6fr)_minmax(6rem,.45fr)_auto]"
              key={row.key}
            >
              <div className="min-w-0">
                <p
                  className={`text-base font-medium ${branch === 0 ? "text-positive" : "text-danger"}`}
                >
                  {symbol}-{branch === 0 ? "YES" : "NO"}
                </p>
                <p className="mt-1 truncate text-sm font-medium text-muted-foreground">
                  {market.question}
                </p>
              </div>
              <div className="text-right sm:text-left">
                <p className="text-base font-medium tabular-nums">
                  {formatNumber(tokenAmount(total.toString(), decimals), 4)}
                </p>
                <p className="mt-1 text-sm font-normal text-muted-foreground">
                  {reserved > 0n
                    ? `${formatTokenAmount(reserved, decimals)} reserved`
                    : "Available"}
                </p>
              </div>
              <div className="hidden sm:block">
                <p className="text-base font-medium tabular-nums">{formatNumber(mark)}</p>
                <p className="mt-1 text-sm font-normal text-muted-foreground">Mark</p>
              </div>
              {kind === "stock" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="col-start-2 row-start-2 justify-self-end bg-danger-soft px-3 text-destructive hover:bg-danger-soft hover:text-destructive sm:col-start-4 sm:row-start-1"
                  disabled={
                    available === 0n ||
                    market.lifecycle !== "open" ||
                    !positions.isDataFresh ||
                    !orders.isDataFresh
                  }
                  onClick={() => {
                    setPrefill({
                      marketId: market.id,
                      branch: branch === 0 ? "YES" : "NO",
                      quantity: formatTokenAmount(available, decimals),
                      nonce: Date.now(),
                    });
                    router.push(`/markets/${market.id}`);
                  }}
                >
                  Close
                </Button>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead>Size incl. reserved</TableHead>
          <TableHead>Avg entry</TableHead>
          <TableHead>Mark</TableHead>
          <TableHead>Mark-to-entry</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const { market, branch, kind, symbol, decimals, available, reserved, total } = row;
          return (
            <TableRow key={row.key}>
              <TableCell
                className={`font-semibold ${branch === 0 ? "text-positive" : "text-danger"}`}
              >
                {symbol}-{branch === 0 ? "YES" : "NO"}
              </TableCell>
              <TableCell className="tabular-nums">
                {formatNumber(tokenAmount(total.toString(), decimals), 4)}
                {reserved > 0n && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatTokenAmount(reserved, decimals)} reserved
                  </p>
                )}
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                <InfoTooltip content="Complete execution basis is not available from the canonical indexer.">
                  <span>—</span>
                </InfoTooltip>
              </TableCell>
              <TableCell className="tabular-nums text-foreground">
                {kind === "stock" ? (
                  formatNumber(midpoint(branch === 0 ? market.yes : market.no))
                ) : (
                  <InfoTooltip content="No direct quote-claim mark is available from the stock orderbook.">
                    <span>—</span>
                  </InfoTooltip>
                )}
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                <InfoTooltip content="An unknown cost basis cannot be treated as zero.">
                  <span>—</span>
                </InfoTooltip>
              </TableCell>
              <TableCell className={softClose ? "text-right" : undefined}>
                {kind === "stock" && (
                  <Button
                    size="sm"
                    variant={softClose ? "ghost" : "outline"}
                    className={
                      softClose
                        ? "border-0 bg-danger-soft px-3 text-destructive hover:bg-danger-soft hover:text-destructive"
                        : undefined
                    }
                    disabled={
                      available === 0n ||
                      market.lifecycle !== "open" ||
                      !positions.isDataFresh ||
                      !orders.isDataFresh
                    }
                    onClick={() => {
                      setPrefill({
                        marketId: market.id,
                        branch: branch === 0 ? "YES" : "NO",
                        quantity: formatTokenAmount(available, decimals),
                        nonce: Date.now(),
                      });
                      if (inline)
                        document
                          .getElementById("trade-ticket")
                          ?.scrollIntoView({ behavior: "smooth", block: "center" });
                      else router.push(`/markets/${market.id}`);
                    }}
                  >
                    Close
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
