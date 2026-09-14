import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@conditional-stocks/ui-kit/table";
import { EmptyState } from "@/components/ui/page";
import { protocolConfig } from "@/config/protocol";
import type { MarketView, TradeView } from "@/types/api";
import {
  displayPrice,
  formatNumber,
  formatTime,
  shortAddress,
  tokenAmount,
} from "@/lib/format/display";
export function TradeTable({ market, trades }: { market: MarketView; trades: TradeView[] }) {
  if (!trades.length) return <EmptyState>No indexed fills for this market yet.</EmptyState>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Branch</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Quantity</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Transaction</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => (
          <TableRow key={trade.id}>
            <TableCell className={trade.branch === 0 ? "text-positive" : "text-danger"}>
              {trade.branch === 0 ? "YES" : "NO"}
            </TableCell>
            <TableCell className="font-mono">
              {formatNumber(displayPrice(trade.executionPriceRawX18, market))}
            </TableCell>
            <TableCell className="font-mono">
              {formatNumber(tokenAmount(trade.fillQuantity, market.baseTokenDecimals), 4)}
            </TableCell>
            <TableCell className="text-xs font-medium text-muted-foreground">
              {formatTime(new Date(Number(trade.blockTimestamp) * 1000).toISOString())}
            </TableCell>
            <TableCell>
              {protocolConfig.explorerUrl ? (
                <a
                  href={`${protocolConfig.explorerUrl.replace(/\/$/, "")}/tx/${trade.transactionHash}`}
                  className="font-mono text-xs text-muted-foreground"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {shortAddress(trade.transactionHash)} ↗
                </a>
              ) : (
                <code>{shortAddress(trade.transactionHash)}</code>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
