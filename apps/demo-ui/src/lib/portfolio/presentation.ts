import { formatPriceRawX18, formatTokenAmount } from "@conditional-stocks/domain";
import type { IndexedOrder, MarketView, TradeView } from "@/types/api";

export interface WalletTradeRow {
  market: MarketView;
  order: IndexedOrder;
  side: "Buy" | "Sell" | "Self-match";
  trade: TradeView;
}

export function walletTradeRows(
  trades: TradeView[],
  orders: IndexedOrder[],
  markets: MarketView[],
): WalletTradeRow[] {
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const marketById = new Map(markets.map((market) => [market.id, market]));
  return trades.flatMap((trade) => {
    const buy = trade.buyOrderHash ? orderById.get(trade.buyOrderHash) : undefined;
    const sell = trade.sellOrderHash ? orderById.get(trade.sellOrderHash) : undefined;
    const maker = trade.makerOrderHash ? orderById.get(trade.makerOrderHash) : undefined;
    const taker = trade.takerOrderHash ? orderById.get(trade.takerOrderHash) : undefined;
    const order = buy ?? sell ?? taker ?? maker;
    const market = marketById.get(trade.marketId);
    if (!order || !market) return [];
    const selfMatch = Boolean((buy && sell) || (maker && taker));
    return [
      {
        market,
        order,
        side: selfMatch
          ? "Self-match"
          : buy
            ? "Buy"
            : sell
              ? "Sell"
              : order.side === 0
                ? "Buy"
                : "Sell",
        trade,
      },
    ];
  });
}

export function tradeHistoryCsv(rows: WalletTradeRow[]) {
  return [
    ["Trade ID", "Market", "Asset", "Side", "Branch", "Quantity", "Price", "Time", "Transaction"],
    ...rows.map(({ market, side, trade }) => [
      trade.id,
      market.question,
      market.ticker,
      side,
      trade.branch === 0 ? "YES" : "NO",
      formatTokenAmount(BigInt(trade.fillQuantity), market.baseTokenDecimals),
      formatPriceRawX18(BigInt(trade.executionPriceRawX18), market),
      new Date(Number(trade.blockTimestamp) * 1000).toISOString(),
      trade.transactionHash,
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

export function wholeReserved(token: string, orders: IndexedOrder[], markets: MarketView[]) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  return orders.reduce((total, order) => {
    if (order.status !== "open" || order.fundingKind !== 0) return total;
    const market = byId.get(order.marketId);
    if (!market) return total;
    const fundingToken = order.side === 0 ? market.quoteToken : market.baseToken;
    return fundingToken === token ? total + BigInt(order.reserved) : total;
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
