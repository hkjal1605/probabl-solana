import { marketAssetKey } from "@/lib/markets/presentation";
import type { MarketView } from "@/types/api";

/** Asset navigation follows the event, not per-asset lifecycle or trading windows. */
export function relatedMarkets(current: MarketView, catalogue: MarketView[]): MarketView[] {
  const unique = new Map(catalogue.map((market) => [market.id, market]));
  unique.set(current.id, current);
  const related = [...unique.values()].filter(
    (market) =>
      market.id === current.id ||
      (current.mapping.conditionId !== "" &&
        market.mapping.conditionId === current.mapping.conditionId &&
        market.mapping.yesIndex === current.mapping.yesIndex &&
        market.mapping.noIndex === current.mapping.noIndex &&
        // An open event never offers frozen (halted or delisted) siblings; they
        // appear once the current market itself is no longer open.
        (current.lifecycle !== "open" || market.lifecycle !== "frozen")),
  );
  const assets = new Map<string, MarketView>();
  for (const market of related) {
    const key = marketAssetKey(market);
    const existing = assets.get(key);
    // Keep the route's current market for its asset. Otherwise prefer an open
    // market, then a stable ID, so a retried deployment cannot duplicate tabs.
    if (
      !existing ||
      market.id === current.id ||
      (existing.id !== current.id &&
        market.lifecycle === "open" &&
        existing.lifecycle !== "open") ||
      (existing.id !== current.id &&
        market.lifecycle === existing.lifecycle &&
        market.id.localeCompare(existing.id) < 0)
    )
      assets.set(key, market);
  }
  return [...assets.values()].sort(
    (a, b) =>
      a.ticker.localeCompare(b.ticker) ||
      a.quoteToken.localeCompare(b.quoteToken) ||
      a.id.localeCompare(b.id),
  );
}
