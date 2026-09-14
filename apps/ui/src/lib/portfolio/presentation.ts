import { formatPriceRawX18, formatTokenAmount } from "@conditional-stocks/domain";
import type { IndexedOrder, MarketView } from "@/types/api";

export function wholeReserved(token: string, orders: IndexedOrder[], markets: MarketView[]) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  return orders.reduce((total, order) => {
    if (order.status !== "open" || order.fundingKind !== 0) return total;
    const market = byId.get(order.marketId);
    if (!market) return total;
    const fundingToken = order.side === 0 ? market.quoteToken : market.baseToken;
    return fundingToken === token
      ? total + BigInt(order.reserved)
      : total;
  }, 0n);
}
/** Escape separators and neutralize spreadsheet formulas in untrusted market labels. */
export function csvCell(value: string) {
  const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function orderHistoryCsv(orders: IndexedOrder[], markets: MarketView[]) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const rows = orders.map((o) => {
    const m = byId.get(o.marketId);
    return [
      o.id,
      o.marketId,
      m?.ticker ?? "",
      o.side === 0 ? "Buy" : "Sell",
      o.branch === 0 ? "YES" : "NO",
      o.status,
      m ? formatTokenAmount(BigInt(o.quantity), m.baseTokenDecimals) : "",
      m ? formatTokenAmount(BigInt(o.filled), m.baseTokenDecimals) : "",
      m ? formatPriceRawX18(BigInt(o.limitPriceRawX18), m) : "",
      o.updatedBlock,
    ];
  });
  return [
    [
      "Order ID",
      "Market ID",
      "Asset",
      "Side",
      "Branch",
      "Status",
      "Quantity",
      "Filled",
      "Limit (USDC)",
      "Updated block",
    ],
    ...rows,
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
