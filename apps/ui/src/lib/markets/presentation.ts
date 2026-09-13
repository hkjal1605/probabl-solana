import type { BranchBook, MarketView } from "@/lib/api/types";

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
  // Group only contracts that share the exact evidence mapping and trading window.
  return [
    market.mapping.conditionId || market.id,
    market.mapping.yesIndex,
    market.mapping.noIndex,
    market.tradingOpen,
    market.cutoff,
    market.lifecycle,
  ].join(":");
}
export function groupMarkets(markets: MarketView[]): MarketView[][] {
  const groups = new Map<string, MarketView[]>();
  for (const market of markets) {
    const key = eventKey(market);
    const group = groups.get(key) ?? [];
    group.push(market);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function marketCategory(market: MarketView) {
  const question = market.question.toLowerCase();
  if (/fed|rate|inflation|cpi|gdp/.test(question)) return "Macro";
  if (/export|tariff|election|policy|ban|regulat/.test(question)) return "Policy";
  if (/revenue|earnings|deliver|quarter|profit/.test(question)) return "Earnings";
  return "Other";
}
export const percent = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
export const compact = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
