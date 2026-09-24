import { expireSpotPrice } from "@conditional-stocks/shared/spot-prices";
import type { BranchBook, MarketView } from "@/types/api";

export const MARKET_CATEGORIES = ["All", "Macro", "Earnings", "Policy", "Other"] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

export function marketCategoryPath(category: MarketCategory) {
  return category === "All" ? "/" : `/category/${category.toLowerCase()}`;
}

export function marketCategoryFromSlug(slug: string): Exclude<MarketCategory, "All"> | null {
  const category = MARKET_CATEGORIES.find(
    (candidate) => candidate !== "All" && candidate.toLowerCase() === slug.toLowerCase(),
  );
  return category && category !== "All" ? category : null;
}

export function marketCategoryFromPathname(pathname: string): MarketCategory | null {
  if (pathname === "/") return "All";
  const match = /^\/category\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? marketCategoryFromSlug(match[1]) : null;
}

export function currentSpotUsd(market: MarketView, nowMs = Date.now()): number | null {
  const spot = market.spotReference && expireSpotPrice(market.spotReference, nowMs);
  return spot?.status === "available" &&
    market.bases.some((leg) => leg.mint === spot.mint) &&
    spot.priceUsd !== null &&
    Number.isFinite(spot.priceUsd) &&
    spot.priceUsd > 0
    ? spot.priceUsd
    : null;
}

/** Display only: intentionally assume one quote token is $1, regardless of mint. */
export function spotImpactPercent(
  market: MarketView,
  branch: "YES" | "NO",
  nowMs = Date.now(),
): number | null {
  const spot = currentSpotUsd(market, nowMs);
  const price = midpoint(branch === "YES" ? market.yes : market.no);
  if (
    (market.bookQuality && market.bookQuality !== "available") ||
    spot === null ||
    price === null ||
    !Number.isFinite(price)
  )
    return null;
  const impact = ((price - spot) / spot) * 100;
  return Number.isFinite(impact) ? impact : null;
}

export function midpoint(book: BranchBook): number | null {
  const { bestBid, bestAsk } = book;
  return bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk >= bestBid
    ? (bestBid + bestAsk) / 2
    : null;
}
export function impactPercent(market: MarketView, branch: "YES" | "NO" = "YES"): number | null {
  const yes = midpoint(market.yes),
    no = midpoint(market.no);
  if (yes === null || no === null) return null;
  const reference = branch === "YES" ? no : yes;
  return reference > 0 ? ((branch === "YES" ? yes - no : no - yes) / reference) * 100 : null;
}
export function eventKey(market: MarketView) {
  // A Polymarket condition plus its outcome orientation is the immutable event
  // identity. Local trading windows and lifecycle state belong to each asset
  // market and must not split one external event into multiple cards.
  return [
    market.mapping.conditionId || market.id,
    market.mapping.yesIndex,
    market.mapping.noIndex,
  ].join(":");
}

const lifecyclePriority: Record<MarketView["lifecycle"], number> = {
  open: 0,
  scheduled: 1,
  frozen: 2,
  "awaiting-resolution": 3,
  resolved: 4,
  redeemable: 5,
  archived: 6,
};

function preferredAssetMarket(current: MarketView, candidate: MarketView): MarketView {
  const lifecycle = lifecyclePriority[current.lifecycle] - lifecyclePriority[candidate.lifecycle];
  if (lifecycle !== 0) return lifecycle < 0 ? current : candidate;
  const opened = Date.parse(current.tradingOpen) - Date.parse(candidate.tradingOpen);
  if (opened !== 0 && Number.isFinite(opened)) return opened < 0 ? current : candidate;
  return current.id.localeCompare(candidate.id) <= 0 ? current : candidate;
}

/** Sibling markets of one event are different assets (NVDA vs TSLA), each multi-issuer. */
export const marketAssetKey = (market: MarketView) => `${market.assetKey}:${market.quoteToken}`;

export function groupMarkets(markets: MarketView[]): MarketView[][] {
  const groups = new Map<string, Map<string, MarketView>>();
  for (const market of markets) {
    const key = eventKey(market);
    const group = groups.get(key) ?? new Map<string, MarketView>();
    const assetKey = marketAssetKey(market);
    const existing = group.get(assetKey);
    group.set(assetKey, existing ? preferredAssetMarket(existing, market) : market);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    [...group.values()].sort(
      (a, b) =>
        a.ticker.localeCompare(b.ticker) ||
        a.quoteToken.localeCompare(b.quoteToken) ||
        a.id.localeCompare(b.id),
    ),
  );
}
export function sortEventGroups(groups: MarketView[][], direction: "newest" | "oldest") {
  const created = (assets: MarketView[]) =>
    Math.max(
      0,
      ...assets.map((m) => {
        const at = Date.parse(m.createdAt ?? "");
        return Number.isFinite(at) ? at : 0;
      }),
    );
  return [...groups].sort((a, b) => {
    const difference = created(b) - created(a);
    return (
      (direction === "oldest" ? -difference : difference) ||
      eventKey(a[0]!).localeCompare(eventKey(b[0]!))
    );
  });
}
export function marketCategory(market: MarketView) {
  const question = market.question.toLowerCase();
  if (/fed|rate|inflation|cpi|gdp/.test(question)) return "Macro";
  if (/export|tariff|election|policy|ban|regulat|\bact\b|\blaw\b/.test(question)) return "Policy";
  if (/revenue|earnings|deliver|quarter|profit/.test(question)) return "Earnings";
  return "Other";
}
export const percent = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
export const compact = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
