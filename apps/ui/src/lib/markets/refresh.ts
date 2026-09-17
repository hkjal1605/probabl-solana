import type { MarketView } from "@/types/api";

const hasProbability = (market: MarketView) =>
  market.probability.value !== null && Number.isFinite(market.probability.value);

/** Retain durable display data across partial upstream failures. Book retention never
 * makes an unavailable snapshot executable; metadata/probability are informational. */
export function retainBookDisplays(previous: unknown, next: { markets: MarketView[] }) {
  const before = previous as { markets?: MarketView[] } | undefined;
  if (!Array.isArray(before?.markets)) return next;
  const old = new Map(before.markets.map((m) => [m.id, m]));
  return {
    markets: next.markets.map((m) => {
      const prior = old.get(m.id);
      const stable =
        m.bookQuality === "unavailable" &&
        prior &&
        prior.baseToken === m.baseToken &&
        prior.quoteToken === m.quoteToken &&
        prior.baseTokenDecimals === m.baseTokenDecimals &&
        prior.quoteTokenDecimals === m.quoteTokenDecimals &&
        prior.protocolVersion === m.protocolVersion &&
        prior.priceFormat === m.priceFormat
          ? { ...m, yes: prior.yes, no: prior.no }
          : m;
      if (!prior) return stable;
      const metadataUnavailable = m.question === `Conditional market ${m.id.slice(0, 8)}`;
      return {
        ...stable,
        description: metadataUnavailable ? prior.description : stable.description,
        imageUrl: stable.imageUrl ?? prior.imageUrl ?? null,
        mapping: {
          ...stable.mapping,
          polymarketUrl:
            metadataUnavailable && prior.mapping.polymarketUrl
              ? prior.mapping.polymarketUrl
              : stable.mapping.polymarketUrl,
        },
        probability:
          !hasProbability(stable) && hasProbability(prior) ? prior.probability : stable.probability,
        question: metadataUnavailable ? prior.question : stable.question,
      };
    }),
  };
}
