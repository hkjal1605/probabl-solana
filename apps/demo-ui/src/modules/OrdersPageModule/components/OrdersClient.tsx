"use client";
import Link from "next/link";
import { useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { DataError, EmptyState, LoadingState } from "@/components/ui/page";
import { Progress } from "@/components/ui/progress";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOrderRecovery } from "@/hooks/useOrderRecovery";
import { displayPrice, formatNumber, shortAddress, tokenAmount } from "@/lib/format/display";
import { cn } from "@/lib/utils";
import type { MarketView } from "@/types/api";

export function OrdersClient({
  markets,
  marketIds,
  embedded = false,
  fixedView,
}: {
  markets: MarketView[];
  marketIds?: string[];
  embedded?: boolean;
  fixedView?: "Open orders" | "History" | "All";
}) {
  const wallet = useWallet(),
    query = useOrderRecovery();
  const [view, setView] = useState<"Open orders" | "History" | "All">("Open orders");
  if (!wallet.account)
    return (
      <EmptyState>
        <p>Connect to see canonical orders.</p>
        <Button variant="default" onClick={() => wallet.connect().catch(() => undefined)}>
          Connect wallet
        </Button>
      </EmptyState>
    );
  const selectedView = fixedView ?? view;
  const orders = [...query.orders].filter(
    (o) =>
      (!marketIds || marketIds.includes(o.marketId)) &&
      (selectedView === "All" ||
        (selectedView === "Open orders" ? o.status === "open" : o.status !== "open")),
  );
  return (
    <Card
      variant="panel"
      className={embedded ? "min-w-0 data-[variant=panel]:bg-transparent" : "border"}
      aria-label="Orders"
    >
      {!fixedView && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            {orders.length} {selectedView.toLowerCase()}
          </span>
          <Segmented
            label="Order status"
            value={selectedView}
            options={["Open orders", "History", "All"]}
            onChange={setView}
          />
        </div>
      )}
      {(query.data?.truncated || query.data?.openTruncated) && (
        <p role="status" className="border-b px-3 py-2 text-xs font-medium text-warning">
          {query.data.openTruncated
            ? "The open-order limit was reached. This list and reservation totals may be incomplete."
            : "Showing the most recent order history plus older open orders. Earlier closed orders are not included."}
        </p>
      )}
      {query.isInitialError ? (
        <DataError
          message="Order history is unavailable. Existing orders are not cancelled."
          retry={() => {
            void query.refetch();
          }}
        />
      ) : query.isPending ? (
        <LoadingState />
      ) : !orders.length ? (
        <EmptyState>
          {selectedView === "Open orders"
            ? "No open orders. Your next opportunity is in Markets."
            : "No closed orders yet."}
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {!embedded && <TableHead>Market</TableHead>}
              <TableHead>Token / side</TableHead>
              <TableHead>Limit</TableHead>
              <TableHead>Filled / qty</TableHead>
              <TableHead>TIF · Funding</TableHead>
              <TableHead>Reserved</TableHead>
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
                  {!embedded && (
                    <TableCell className="max-w-52 whitespace-normal">
                      <Link
                        href={`/markets/${order.marketId}`}
                        className="line-clamp-2 font-medium"
                      >
                        {market?.question ?? shortAddress(order.marketId)}
                      </Link>
                      <InfoTooltip content={order.id}>
                        <code className="mt-1 block text-muted-foreground">
                          {shortAddress(order.id)}
                        </code>
                      </InfoTooltip>
                    </TableCell>
                  )}
                  <TableCell>
                    <span
                      className={cn(
                        "font-semibold",
                        order.branch === 0 ? "text-positive" : "text-danger",
                      )}
                    >
                      {market?.ticker ?? "Stock"}-{order.branch === 0 ? "YES" : "NO"}
                    </span>
                    <p className="mt-1 text-muted-foreground">
                      {order.side === 0 ? "Buy" : "Sell"}
                    </p>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {market ? formatNumber(displayPrice(order.limitPriceRawX18, market)) : "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {market
                      ? `${formatNumber(tokenAmount(order.filled, market.baseTokenDecimals), 3)} / ${formatNumber(tokenAmount(order.quantity, market.baseTokenDecimals), 3)}`
                      : "—"}
                    <Progress
                      className="mt-2"
                      aria-label="Order filled"
                      value={
                        BigInt(order.quantity) > 0n
                          ? Math.max(
                              0,
                              Math.min(
                                100,
                                Number((BigInt(order.filled) * 10000n) / BigInt(order.quantity)) /
                                  100,
                              ),
                            )
                          : 0
                      }
                    />
                  </TableCell>
                  <TableCell className="text-foreground">
                    {order.tif === 0 ? "GTC" : "IOC"} ·{" "}
                    {order.fundingKind === 0 ? "Whole" : "Active claim"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {market
                      ? `${formatNumber(tokenAmount(order.reserved, order.side === 0 ? market.quoteTokenDecimals : market.baseTokenDecimals), 4)} ${order.side === 0 ? "USDC" : market.ticker}`
                      : "—"}
                    {order.fundingKind === 1 && `-${order.branch === 0 ? "YES" : "NO"}`}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        partial ? "warning" : order.status === "open" ? "positive" : "secondary"
                      }
                    >
                      {partial ? "Partially filled" : order.status}
                    </Badge>
                  </TableCell>
                  <TableCell className={embedded ? "text-right" : undefined}>
                    {order.status === "open" && (
                      <Button
                        size="sm"
                        variant={embedded ? "ghost" : "link"}
                        className={cn(
                          embedded &&
                            "border-0 bg-danger-soft px-3 text-destructive hover:bg-danger-soft hover:text-destructive",
                        )}
                        disabled={query.canceling !== null || query.pending.has(order.id)}
                        onClick={() =>
                          query.cancel(order.id, expired ? "expired" : closed ? "closed" : "cancel")
                        }
                      >
                        {query.canceling === order.id && <Spinner className="animate-spin" />}
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
    </Card>
  );
}
