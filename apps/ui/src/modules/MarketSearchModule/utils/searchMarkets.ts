import type { MarketView } from "@/types/api";

export const SEARCH_DELAY_MS = 250;
export const SEARCH_LIMIT = 50;
export const normalizeSearch = (value: string) => value.normalize("NFKC").trim().toLowerCase();

/** Search discovery metadata only. Never interpret a query as a URL or a trading action. */
export function searchMarkets(markets: MarketView[], query: string) {
  const normalized = normalizeSearch(query);
  const words = normalized.split(/\s+/).filter(Boolean);
  const matches = markets.filter((market) => {
    const text = normalizeSearch(
      [
        market.question,
        market.ticker,
        market.assetMetadata?.name,
        market.assetMetadata?.symbol,
        market.quoteTokenMetadata?.name,
        market.quoteTokenMetadata?.symbol,
        ...market.bases.flatMap((leg) => [leg.mint, leg.symbol, leg.issuer]),
        market.quoteToken,
        market.id,
      ]
        .filter(Boolean)
        .join(" "),
    );
    return words.every((word) => text.includes(word));
  });
  const score = (market: MarketView) =>
    (normalized &&
    [market.id, ...market.bases.map((leg) => leg.mint), market.quoteToken].some(
      (v) => normalizeSearch(v) === normalized,
    )
      ? 4
      : 0) +
    (normalized && normalizeSearch(market.ticker) === normalized ? 2 : 0) +
    (market.lifecycle === "open" ? 1 : 0);
  matches.sort(
    (a, b) =>
      score(b) - score(a) ||
      a.question.localeCompare(b.question) ||
      a.ticker.localeCompare(b.ticker) ||
      a.id.localeCompare(b.id),
  );
  return { items: matches.slice(0, SEARCH_LIMIT), total: matches.length };
}

/** Do not steal slash from typing, shortcuts, IME composition, or another modal. */
export function shouldOpenMarketSearch(event: KeyboardEvent) {
  if (
    event.key !== "/" ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return false;
  const target = event.composedPath()[0];
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
      ))
  )
    return false;
  return !document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
}
