import type { MarketCategory } from "@/lib/markets/presentation";

export interface FeaturedMarketDefinition {
  conditionId: string;
  imageSrc: string;
}

export const FEATURED_MARKETS: Record<MarketCategory, FeaturedMarketDefinition> = {
  All: {
    conditionId: "0xf9c12aa09c5317d1cf8d26d0dc100a69ecf70e5132e81ef078d5336f63923b5e",
    imageSrc: "/markets/us-china-tariff-feature.webp",
  },
  Macro: {
    conditionId: "0xc60022fe066abd6f96c375adb09f38d92c4931f09c10b805354581b4e5465e93",
    imageSrc: "/markets/fed-rate-cut-feature.webp",
  },
  Earnings: {
    conditionId: "0xe3fe2b872da1f1f445cde31bb58ca3ddc690a7af19518807a14ce827bd2ed6de",
    imageSrc: "/markets/micron-earnings-feature.webp",
  },
  Policy: {
    conditionId: "0x9cb23d04b2ded06147482076688b69b487a8d982c63ebdda2ab3678cf27cf390",
    imageSrc: "/markets/clarity-act-feature.webp",
  },
  Other: {
    conditionId: "0x857398c4502bc725fef7efb3cd503a30d3e18e486ab8173fdf505a76cf83b168",
    imageSrc: "/markets/ai-bubble-feature.webp",
  },
};

export const FEATURED_MARKET_IMAGES = Object.values(FEATURED_MARKETS).map(
  (definition) => definition.imageSrc,
);
