export type SeedCategory = "Macro" | "Earnings" | "Policy" | "Other";

export interface SeedMarket {
  category: SeedCategory;
  gammaMarketId: string;
  slug: string;
  question: string;
}

/** Reviewed on 2026-09-19. Every entry is a live binary condition whose
 * resolution is a real-world catalyst rather than an asset-price threshold. */
export const DEVNET_MARKET_SEED: readonly SeedMarket[] = [
  {
    category: "Macro",
    gammaMarketId: "690215",
    slug: "will-the-feds-lower-bound-reach-2pt75-or-lower-before-2027-448-727-854",
    question: "Will the Fed’s lower bound reach 2.75% or lower before 2027?",
  },
  {
    category: "Macro",
    gammaMarketId: "609655",
    slug: "us-recession-by-end-of-2026",
    question: "US recession by end of 2026?",
  },
  {
    category: "Macro",
    gammaMarketId: "1439555",
    slug: "fed-rate-cut-by-december-2026-meeting",
    question: "Fed rate cut by December 2026 meeting?",
  },
  {
    category: "Earnings",
    gammaMarketId: "4440717",
    slug: "ctas-quarterly-earnings-gaap-eps-09-23-2026-1pt37",
    question: "Will Cintas (CTAS) beat quarterly earnings?",
  },
  {
    category: "Earnings",
    gammaMarketId: "4622920",
    slug: "mu-quarterly-earnings-nongaap-eps-09-30-2026-32pt22",
    question: "Will Micron (MU) beat quarterly earnings?",
  },
  {
    category: "Earnings",
    gammaMarketId: "4440720",
    slug: "cost-quarterly-earnings-gaap-eps-09-24-2026-6pt69",
    question: "Will Costco (COST) beat quarterly earnings?",
  },
  {
    category: "Policy",
    gammaMarketId: "2382827",
    slug: "us-x-china-tariff-agreement-by-december-31",
    question: "US x China tariff agreement by December 31?",
  },
  {
    category: "Policy",
    gammaMarketId: "1720308",
    slug: "law-banning-sports-prediction-markets-enacted-in-2026",
    question: "Law banning sports prediction markets enacted in 2026?",
  },
  {
    category: "Policy",
    gammaMarketId: "1163699",
    slug: "clarity-act-signed-into-law-in-2026",
    question: "Clarity Act (H.R.3633) signed into law in 2026?",
  },
  {
    category: "Other",
    gammaMarketId: "665374",
    slug: "will-the-us-invade-iran-before-2027",
    question: "Will the U.S. invade Iran before 2027?",
  },
  {
    category: "Other",
    gammaMarketId: "567621",
    slug: "will-china-invade-taiwan-before-2027",
    question: "Will China invade Taiwan by end of 2026?",
  },
  {
    category: "Other",
    gammaMarketId: "691340",
    slug: "ai-industry-downturn-by-december-31-2026-857",
    question: "AI bubble burst in 2026?",
  },
] as const;

const categoryFor = (question: string): SeedCategory => {
  const value = question.toLowerCase();
  if (/fed|rate|inflation|cpi|gdp|recession/.test(value)) return "Macro";
  if (/export|tariff|election|policy|ban|regulat|\bact\b|\blaw\b/.test(value)) return "Policy";
  if (/revenue|earnings|deliver|quarter|profit/.test(value)) return "Earnings";
  return "Other";
};

export function validateMarketSeed(markets: readonly SeedMarket[] = DEVNET_MARKET_SEED) {
  const categories: SeedCategory[] = ["Macro", "Earnings", "Policy", "Other"];
  if (markets.length < categories.length * 3)
    throw new Error("At least three events per category are required");
  if (new Set(markets.map((market) => market.gammaMarketId)).size !== markets.length)
    throw new Error("Duplicate Gamma market id");
  if (new Set(markets.map((market) => market.slug)).size !== markets.length)
    throw new Error("Duplicate Polymarket slug");
  for (const market of markets) {
    if (
      !/^[1-9][0-9]*$/.test(market.gammaMarketId) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(market.slug)
    )
      throw new Error("Invalid Polymarket identity");
    if (categoryFor(market.question) !== market.category)
      throw new Error(`Question does not render under ${market.category}: ${market.slug}`);
  }
  for (const category of categories)
    if (markets.filter((market) => market.category === category).length < 3)
      throw new Error(`Missing ${category} events`);
  return markets;
}
