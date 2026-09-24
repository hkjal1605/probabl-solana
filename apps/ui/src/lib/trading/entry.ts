import {
  formatPriceRawX18,
  formatShareAmount,
  MAX_ORDER_UINT128,
  parsePriceRawX18,
  parseTokenAmount,
} from "@conditional-stocks/domain";
import { bestLevelFor } from "@/lib/markets/legs";
import type { MarketView } from "@/types/api";

/** Round down to an onchain share step; never exceed the entered quote budget. */
export function quantityForSpend(spend: string, price: string, market: MarketView): string {
  const budget = parseTokenAmount(spend, market.quoteTokenDecimals);
  const rawPrice = parsePriceRawX18(price, market);
  const step = BigInt(market.baseStep);
  if (budget <= 0n || rawPrice <= 0n || step <= 0n)
    throw new Error("Enter a positive budget and price");
  const raw = ((budget * 10n ** 18n) / rawPrice / step) * step;
  if (raw <= 0n || raw >= 1n << 64n)
    throw new Error("Budget is outside the supported quantity range");
  return formatShareAmount(raw, market);
}

/**
 * Best executable price for the selected issuer set: a buy accepting `mask`
 * takes asks of those issuers; a sell of one issuer hits bids that accept it.
 * `mask = null` considers the whole book.
 */
export function bestPriceFor(
  market: MarketView,
  branch: "YES" | "NO",
  side: "buy" | "sell",
  mask: number | null = null,
): string | null {
  return bestLevelFor(branch === "YES" ? market.yes : market.no, side, mask)?.priceExact ?? null;
}

/** A market order is IOC with a signed, bounded worst price, never an unbounded order. */
export function marketPriceBound(
  market: MarketView,
  branch: "YES" | "NO",
  side: "buy" | "sell",
  slippageBps = 100,
  mask: number | null = null,
): string {
  if (market.bookQuality && market.bookQuality !== "available")
    throw new Error("Wait for a fresh order book before setting a market-order bound");
  const book = branch === "YES" ? market.yes : market.no;
  const price =
    mask === null
      ? side === "buy"
        ? book.bestAskExact
        : book.bestBidExact
      : bestPriceFor(market, branch, side, mask);
  if (!price || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000)
    throw new Error("No executable price bound");
  const raw = parsePriceRawX18(price, market);
  const tick = BigInt(market.priceTickRawX18 ?? "1");
  if (tick <= 0n) throw new Error("Invalid market price tick");
  // Round inward to the tick grid so the bound never exceeds the stated slippage.
  const bound =
    side === "buy"
      ? ((raw * BigInt(10000 + slippageBps)) / 10000n / tick) * tick
      : ((raw * BigInt(10000 - slippageBps) + 10000n * tick - 1n) / (10000n * tick)) * tick;
  if (bound <= 0n || bound > MAX_ORDER_UINT128)
    throw new Error("Price is outside the supported range");
  return formatPriceRawX18(bound, market);
}
