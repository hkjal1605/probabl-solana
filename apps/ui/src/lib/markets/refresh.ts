import type { MarketView } from "@/types/api";

const hasProbability = (market: MarketView) =>
  market.probability.value !== null && Number.isFinite(market.probability.value);

/** Same listed issuer legs (mint, decimals, scale); a book of other legs is never retained. */
const sameLegs = (a: MarketView, b: MarketView) =>
  a.bases.length === b.bases.length &&
  a.bases.every((leg, index) => {
    const other = b.bases[index];
    return (
      other !== undefined &&
      leg.mint === other.mint &&
      leg.decimals === other.decimals &&
      leg.scale === other.scale
    );
  });

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
        sameLegs(prior, m) &&
        prior.quoteToken === m.quoteToken &&
        prior.shareDecimals === m.shareDecimals &&
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
