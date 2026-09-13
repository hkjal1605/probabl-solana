import type { MarketView, TradeView } from "@/lib/api/types";
import { displayPrice } from "@/lib/format/display";

export interface PricePoint {
  id: string;
  at: number;
  branch: number;
  price: number;
}
export function executionPoints(trades: TradeView[], market: MarketView, since = 0): PricePoint[] {
  return trades
    .filter((t) => t.marketId === market.id && (t.branch === 0 || t.branch === 1))
    .map((t) => ({
      id: t.id,
      at: Number(t.blockTimestamp),
      branch: t.branch,
      price: displayPrice(t.executionPriceRawX18, market),
    }))
    .filter(
      (p) => Number.isFinite(p.at) && p.at >= since && Number.isFinite(p.price) && p.price > 0,
    )
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
/** Compare the most recently executed prices, never invent a missing branch or imply historical book quotes. */
export function executionImpact(points: PricePoint[]): PricePoint[] {
  let yes: number | null = null,
    no: number | null = null;
  const result: PricePoint[] = [];
  for (const point of points) {
    if (point.branch === 0) yes = point.price;
    else no = point.price;
    if (yes !== null && no !== null && no > 0)
      result.push({ ...point, branch: 0, price: ((yes - no) / no) * 100 });
  }
  return result;
}
