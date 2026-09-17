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

  const quoteMarkets = new Map<string, MarketView[]>();
  for (const market of markets) {
    const key = `${market.mapping.conditionId}:${market.quoteToken}`;
    quoteMarkets.set(key, [...(quoteMarkets.get(key) ?? []), market]);
  }
  const quoteRows = [...quoteMarkets.entries()].flatMap(([claimKey, claimMarkets]) => {
    const market = claimMarkets[0];
    if (!market) return [];
    const marketIds = new Set(claimMarkets.map((item) => item.id));
    const position = positions.find((item) => marketIds.has(item.marketId));
    return ([0, 1] as const).map((branch) => {
      const available = BigInt((branch === 0 ? position?.quoteYes : position?.quoteNo) ?? "0");
      const reserved = reservedClaims(orders, marketIds, branch, 0);
      return {
        available,
        branch,
        decimals: market.quoteTokenDecimals,
        key: `quote-${claimKey}-${branch}`,
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
