"use client";
import { Badge } from "@conditional-stocks/ui-kit/badge";
import { Button } from "@conditional-stocks/ui-kit/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@conditional-stocks/ui-kit/table";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { DataError, EmptyState } from "@/components/ui/page";
import { Segmented } from "@/components/ui/segmented";
import { useOrderRecovery } from "@/hooks/useOrderRecovery";
import { RefreshStatus } from "@/components/data/RefreshStatus";
import type { MarketView } from "@/lib/api/types";
import { displayPrice, formatNumber, shortAddress, tokenAmount } from "@/lib/format/display";

export function OrdersClient({
  markets,
  marketIds,
  embedded = false,
}: {
  markets: MarketView[];
  marketIds?: string[];
  embedded?: boolean;
}) {
  const wallet = useWallet(),
    query = useOrderRecovery();
  const [view, setView] = useState<"Open orders" | "History" | "All">("Open orders");
  if (!wallet.account)
    return (
      <EmptyState>
        <p>Connect to see canonical orders.</p>
        <Button variant="brand" onClick={() => wallet.connect().catch(() => undefined)}>
          Connect wallet
        </Button>
      </EmptyState>
    );
  const orders = [...query.orders].filter(
    (o) =>
      (!marketIds || marketIds.includes(o.marketId)) &&
      (view === "All" || (view === "Open orders" ? o.status === "open" : o.status !== "open")),
  );
  return (
    <section className={embedded ? "min-w-0" : "panel"} aria-label="Orders">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <span className="text-xs font-medium text-muted-foreground">
          {orders.length} {view.toLowerCase()}
        </span>
        <Segmented
          label="Order status"
          value={view}
          options={["Open orders", "History", "All"]}
          onChange={setView}
        />
      </div>
      {(query.data?.truncated || query.data?.openTruncated) && (
        <p role="status" className="border-b px-5 py-3 text-xs font-medium text-warning">
          {query.data.openTruncated
            ? "The open-order limit was reached. This list and reservation totals may be incomplete."
            : "Showing the most recent order history plus older open orders. Earlier closed orders are not included."}
        </p>
      )}
      <RefreshStatus active={query.isRefreshError} label="orders" />
      {query.isInitialError ? (
        <DataError
          message="Order history is unavailable. Existing orders are not cancelled."
          retry={() => {
            void query.refetch();
          }}
        />
      ) : query.isPending ? (
        <EmptyState>Reading canonical orders…</EmptyState>
      ) : !orders.length ? (
        <EmptyState>
          {view === "Open orders"
            ? "No open orders. Your next opportunity is in Markets."
            : "No closed orders yet."}
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Market</TableHead>
              <TableHead>Token / side</TableHead>
              <TableHead>Limit</TableHead>
              <TableHead>Filled / qty</TableHead>
              <TableHead>TIF · Funding</TableHead>
              <TableHead>Reserved / fees</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => {
              const market = markets.find((m) => m.id === order.marketId),
                partial = BigInt(order.filled) > 0n && BigInt(order.remaining) > 0n;
              const expired = BigInt(order.expiry) <= BigInt(Math.floor(Date.now() / 1000));
              const closed = Boolean(
                market &&
                  ["frozen", "awaiting-resolution", "resolved", "redeemable", "archived"].includes(
                    market.lifecycle,
                  ),
              );
              return (
                <TableRow key={order.id}>
                  <TableCell className="max-w-52 whitespace-normal">
                    <Link href={`/markets/${order.marketId}`} className="line-clamp-2 font-medium">
                      {market?.question ?? shortAddress(order.marketId)}
                    </Link>
                    <code className="mt-1 block text-xs text-muted-foreground" title={order.id}>
                      {shortAddress(order.id)}
                    </code>
                  </TableCell>
                  <TableCell>
                    <strong className={order.branch === 0 ? "text-positive" : "text-danger"}>
                      {market?.ticker ?? "Stock"}-{order.branch === 0 ? "YES" : "NO"}
                    </strong>
                    <p
                      className={`text-xs font-medium ${order.side === 0 ? "text-positive" : "text-danger"}`}
                    >
                      {order.side === 0 ? "Buy" : "Sell"}
                    </p>
                  </TableCell>
                  <TableCell className="font-mono">
                    {market ? formatNumber(displayPrice(order.limitPriceRawX18, market)) : "—"}
                  </TableCell>
                  <TableCell className="font-mono">
                    {market
                      ? `${formatNumber(tokenAmount(order.filled, market.baseTokenDecimals), 3)} / ${formatNumber(tokenAmount(order.quantity, market.baseTokenDecimals), 3)}`
                      : "—"}
                    <div className="mt-2 h-1 rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-positive"
                        style={{
                          width: `${BigInt(order.quantity) > 0n ? Math.min(100, Number((BigInt(order.filled) * 10000n) / BigInt(order.quantity)) / 100) : 0}%`,
                        }}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-xs font-medium text-muted-foreground">
                    {order.tif === 0 ? "GTC" : "IOC"} ·{" "}
                    {order.fundingKind === 0 ? "Whole" : "Active claim"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {market
                      ? `${formatNumber(tokenAmount(order.reserved, order.side === 0 ? market.quoteTokenDecimals : market.baseTokenDecimals), 4)} ${order.side === 0 ? "USDC" : market.ticker}`
                      : "—"}
                    {order.fundingKind === 1 && `-${order.branch === 0 ? "YES" : "NO"}`}
                    <p className="mt-1 text-muted-foreground">
                      Fees:{" "}
                      {market && order.feesPaid !== undefined
                        ? `${formatNumber(tokenAmount(order.feesPaid, order.side === 0 ? market.baseTokenDecimals : market.quoteTokenDecimals), 4)} ${order.side === 0 ? market.ticker : "USDC"} claims`
                        : "—"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        partial ? "warning" : order.status === "open" ? "positive" : "secondary"
                      }
                    >
                      {partial ? "Partially filled" : order.status}
                    </Badge>
                    {order.confirmation && (
                      <p className="mt-1 text-xs text-muted-foreground">{order.confirmation}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    {order.status === "open" && (
                      <Button
                        size="sm"
                        variant="link"
                        disabled={query.canceling !== null || query.pending.has(order.id)}
                        onClick={() =>
                          query.cancel(order.id, expired ? "expired" : closed ? "closed" : "cancel")
                        }
                      >
                        {query.canceling === order.id && <LoaderCircle className="animate-spin" />}
                        {query.pending.has(order.id)
                          ? "Pending chain"
                          : expired || closed
                            ? "Release escrow"
                            : "Cancel"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
