export interface LevelOrder {
  market: string;
  branch: number;
  side: number;
  limitPriceRawX18: string;
  remaining: string;
  /** Wire base-leg mask: an ask's single delivered leg, a bid's accepted legs. */
  bases: number;
}

export interface OrderbookLevel {
  branch: number;
  side: number;
  limitPriceRawX18: string;
  /** Level total in share units. */
  remaining: string;
  /** Remaining share units by base-leg mask (decimal mask -> share units). */
  byBases: Record<string, string>;
}

/** Collapse owner-specific orders into the price levels needed by public list views. */
export function compactOrderbooks(marketIds: Iterable<string>, orders: Iterable<LevelOrder>) {
  const levels = new Map<string, Map<string, OrderbookLevel>>();
  for (const market of marketIds) levels.set(market, new Map());
  for (const order of orders) {
    const book = levels.get(order.market);
    if (!book) continue;
    const key = `${order.branch}:${order.side}:${order.limitPriceRawX18}`;
    const level = book.get(key) ?? {
      branch: order.branch,
      side: order.side,
      limitPriceRawX18: order.limitPriceRawX18,
      remaining: "0",
      byBases: {},
    };
    const mask = String(order.bases);
    level.remaining = (BigInt(level.remaining) + BigInt(order.remaining)).toString();
    level.byBases[mask] = (BigInt(level.byBases[mask] ?? 0) + BigInt(order.remaining)).toString();
    book.set(key, level);
  }
  return Object.fromEntries(
    [...levels].map(([market, book]) => [
      market,
      { orders: [...book.values()], truncated: false as const },
    ]),
  );
}
