export interface LevelOrder {
  market: string;
  branch: number;
  side: number;
  limitPriceRawX18: string;
  remaining: string;
}

export interface OrderbookLevel {
  branch: number;
  side: number;
  limitPriceRawX18: string;
  remaining: string;
}

/** Collapse owner-specific orders into the price levels needed by public list views. */
export function compactOrderbooks(marketIds: Iterable<string>, orders: Iterable<LevelOrder>) {
  const levels = new Map<string, Map<string, OrderbookLevel>>();
  for (const market of marketIds) levels.set(market, new Map());
  for (const order of orders) {
    const book = levels.get(order.market);
    if (!book) continue;
    const key = `${order.branch}:${order.side}:${order.limitPriceRawX18}`;
    const current = book.get(key);
    book.set(key, {
      branch: order.branch,
      side: order.side,
      limitPriceRawX18: order.limitPriceRawX18,
      remaining: (BigInt(current?.remaining ?? 0) + BigInt(order.remaining)).toString(),
    });
  }
  return Object.fromEntries(
    [...levels].map(([market, book]) => [
      market,
      { orders: [...book.values()], truncated: false as const },
    ]),
  );
}
