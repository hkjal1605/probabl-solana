"use client";
import { formatTokenAmount } from "@conditional-stocks/domain";
import { Button } from "@conditional-stocks/ui-kit/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@conditional-stocks/ui-kit/table";
import { useRouter } from "next/navigation";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { useWallet } from "@/components/providers/WalletProvider";
import { DataError, EmptyState } from "@/components/ui/page";
import { useOrders, usePositions } from "@/hooks/useProtocolData";
import type { MarketView } from "@/lib/api/types";
import { formatNumber, tokenAmount } from "@/lib/format/display";
import { midpoint } from "@/lib/markets/presentation";
import { RefreshStatus } from "@/components/data/RefreshStatus";

export function PositionTable({
  markets,
  inline = false,
}: {
  markets: MarketView[];
  inline?: boolean;
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
  if (positions.isPending || orders.isPending) return <EmptyState>Reading positions…</EmptyState>;
  const refreshing = positions.isRefreshError || orders.isRefreshError;
  const rows = markets
    .flatMap((market) =>
      ([0, 1] as const).map((branch) => {
        const p = positions.positions.find((position) => position.marketId === market.id);
        const available = BigInt((branch === 0 ? p?.stockYes : p?.stockNo) ?? "0");
        const reserved = orders.orders
          .filter(
            (o) =>
              o.marketId === market.id &&
              o.branch === branch &&
              o.side === 1 &&
              o.fundingKind === 1 &&
              o.status === "open",
          )
          .reduce((sum, order) => sum + BigInt(order.reserved), 0n);
        return { market, branch, available, reserved, total: available + reserved };
      }),
    )
    .filter((row) => row.total > 0n);
  if (!rows.length)
    return (
      <>
        <RefreshStatus active={refreshing} label="positions" />
        <EmptyState>
          {positions.isPending ? "Reading positions…" : "No stock positions in this event yet."}
        </EmptyState>
      </>
    );
  return (
    <>
      <RefreshStatus active={refreshing} label="positions" />
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
          {rows.map(({ market, branch, available, reserved, total }) => (
            <TableRow key={`${market.id}-${branch}`}>
              <TableCell
                className={`font-semibold ${branch === 0 ? "text-positive" : "text-danger"}`}
              >
                {market.ticker}-{branch === 0 ? "YES" : "NO"}
              </TableCell>
              <TableCell className="font-mono">
                {formatNumber(tokenAmount(total.toString(), market.baseTokenDecimals), 4)}
                {reserved > 0n && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatTokenAmount(reserved, market.baseTokenDecimals)} reserved
                  </p>
                )}
              </TableCell>
              <TableCell
                className="font-mono text-muted-foreground"
                title="Complete execution basis is not available from the canonical indexer."
              >
                —
              </TableCell>
              <TableCell className="font-mono">
                {formatNumber(midpoint(branch === 0 ? market.yes : market.no))}
              </TableCell>
              <TableCell
                className="font-mono text-muted-foreground"
                title="An unknown cost basis cannot be treated as zero."
              >
                —
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="outline"
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
                      quantity: formatTokenAmount(available, market.baseTokenDecimals),
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
