import type { IndexedOrder, MarketView, PositionView } from "@/types/api";

export interface ConditionalPositionRow {
  available: bigint;
  branch: 0 | 1;
  decimals: number;
  key: string;
  kind: "quote" | "stock";
  market: MarketView;
  reserved: bigint;
  symbol: string;
  total: bigint;
}

const reservedClaims = (
  orders: IndexedOrder[],
  marketIds: Set<string>,
  branch: 0 | 1,
  side: 0 | 1,
) =>
  orders
    .filter(
      (order) =>
        marketIds.has(order.marketId) &&
        order.branch === branch &&
        order.side === side &&
        order.fundingKind === 1 &&
        order.status === "open",
    )
    .reduce((sum, order) => sum + BigInt(order.reserved), 0n);

export function conditionalPositionRows(
  markets: MarketView[],
  positions: PositionView[],
  orders: IndexedOrder[],
): ConditionalPositionRow[] {
  const stockRows = markets.flatMap((market) =>
    ([0, 1] as const).map((branch) => {
      const position = positions.find((item) => item.marketId === market.id);
      const available = BigInt((branch === 0 ? position?.stockYes : position?.stockNo) ?? "0");
      const reserved = reservedClaims(orders, new Set([market.id]), branch, 1);
      return {
        available,
        branch,
        decimals: market.baseTokenDecimals,
        key: `stock-${market.id}-${branch}`,
        kind: "stock" as const,
        market,
        reserved,
        symbol: market.ticker,
        total: available + reserved,
      };
    }),
  );

  // Even sibling markets for the same event have distinct quote-claim mints.
  const quoteRows = markets.flatMap((market) => {
    const marketIds = new Set([market.id]);
    const position = positions.find((item) => item.marketId === market.id);
    return ([0, 1] as const).map((branch) => {
      const available = BigInt((branch === 0 ? position?.quoteYes : position?.quoteNo) ?? "0");
      const reserved = reservedClaims(orders, marketIds, branch, 0);
      return {
        available,
        branch,
        decimals: market.quoteTokenDecimals,
        key: `quote-${market.id}-${branch}`,
        kind: "quote" as const,
        market,
        reserved,
        symbol: market.quoteTokenMetadata?.symbol ?? "USDC",
        total: available + reserved,
      };
    });
  });

  return [...stockRows, ...quoteRows].filter((row) => row.total > 0n);
}
