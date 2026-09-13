import type { MarketView } from "@/lib/api/types";

/** Retain display-only book rows after a partial refresh, never mark them executable. */
export function retainBookDisplays(previous: unknown, next: { markets: MarketView[] }) {
  const before = previous as { markets?: MarketView[] } | undefined;
  if (!Array.isArray(before?.markets)) return next;
  const old = new Map(before.markets.map((m) => [m.id, m]));
  return {
    markets: next.markets.map((m) => {
      const prior = old.get(m.id);
      return m.bookQuality === "unavailable" &&
        prior &&
        prior.baseToken === m.baseToken &&
        prior.quoteToken === m.quoteToken &&
        prior.baseTokenDecimals === m.baseTokenDecimals &&
        prior.quoteTokenDecimals === m.quoteTokenDecimals &&
        prior.protocolVersion === m.protocolVersion &&
        prior.priceFormat === m.priceFormat
        ? { ...m, yes: prior.yes, no: prior.no }
        : m;
    }),
  };
}
