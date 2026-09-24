import { MARKET_TICKERS } from "./devnet-policy.ts";

export type SeedCategory = "Macro" | "Earnings" | "Policy" | "Other";
export type SeedTicker = (typeof MARKET_TICKERS)[number];

export interface SeedMarket {
  category: SeedCategory;
  gammaMarketId: string;
  slug: string;
  question: string;
  /** The three assets whose markets this event lists, each directly exposed to it. */
  tickers: readonly [SeedTicker, SeedTicker, SeedTicker];
}

/** Reviewed on 2026-09-25 for the demo catalogue: every entry is a live binary
 * (Yes/No, not negative-risk) condition whose outcome plausibly moves each of
 * its three assets. Every asset is tied to at least two events. */
export const DEVNET_MARKET_SEED: readonly SeedMarket[] = [
  {
    category: "Macro",
    gammaMarketId: "690215",
    slug: "will-the-feds-lower-bound-reach-2pt75-or-lower-before-2027-448-727-854",
    question: "Will the Fed’s lower bound reach 2.75% or lower before 2027?",
    // Rate cuts: growth equities, the index and the richest private valuation.
    tickers: ["TSLA", "SPY", "SPACEX"],
  },
  {
    category: "Macro",
    gammaMarketId: "609655",
    slug: "us-recession-by-end-of-2026",
    question: "US recession by end of 2026?",
    // The broad market and its two most cyclical mega-caps.
    tickers: ["NVDA", "TSLA", "SPY"],
  },
  {
    category: "Other",
    gammaMarketId: "691340",
    slug: "ai-industry-downturn-by-december-31-2026-857",
    question: "AI bubble burst in 2026?",
    // The AI trade: the chip supplier and the two leading labs.
    tickers: ["NVDA", "OPENAI", "ANTHROPIC"],
  },
  {
    category: "Other",
    gammaMarketId: "2413330",
    slug: "will-anthropic-ipo-by-december-31-2026-546-128-719",
    question: "Will Anthropic IPO by December 31, 2026?",
    // The IPO window for pre-IPO tokens: the issuer, its closest peer, Kalshi.
    tickers: ["ANTHROPIC", "OPENAI", "KALSHI"],
  },
  {
    category: "Other",
    gammaMarketId: "656312",
    slug: "will-openai-ipo-by-december-31-2026",
    question: "Will OpenAI IPO by December 31 2026?",
    tickers: ["OPENAI", "ANTHROPIC", "KALSHI"],
  },
  {
    category: "Other",
    gammaMarketId: "2252540",
    slug: "tesla-and-spacex-merger-officially-announced-by-december-31",
    question: "Tesla and SpaceX merger officially announced by December 31?",
    // Both merger parties, and Nvidia as the GPU supplier to xAI and Tesla.
    tickers: ["SPACEX", "TSLA", "NVDA"],
  },
  {
    category: "Policy",
    gammaMarketId: "1163699",
    slug: "clarity-act-signed-into-law-in-2026",
    question: "Clarity Act (H.R.3633) signed into law in 2026?",
    // US crypto market structure: SEC/CFTC jurisdiction over BTC, ETH and SOL.
    tickers: ["BTC", "ETH", "SOL"],
  },
  {
    category: "Other",
    gammaMarketId: "1343533",
    slug: "major-cex-insolvent-in-2026",
    question: "Major CEX insolvent in 2026?",
    // Exchange-failure contagion across the major crypto assets.
    tickers: ["BTC", "ETH", "SOL"],
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
    if (
      market.tickers.length !== 3 ||
      new Set(market.tickers).size !== 3 ||
      market.tickers.some((ticker) => !MARKET_TICKERS.includes(ticker))
    )
      throw new Error(`Every event lists three distinct assets: ${market.slug}`);
  }
  for (const ticker of MARKET_TICKERS)
    if (markets.filter((market) => market.tickers.includes(ticker)).length < 2)
      throw new Error(`${ticker} is tied to fewer than two events`);
  return markets;
}
