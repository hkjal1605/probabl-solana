import type { WalletAssetBalance } from "@/hooks/useWalletAssets";
import { tokenAmount } from "@/lib/format/display";
import { midpoint } from "@/lib/markets/presentation";
import { conditionalPositionRows } from "@/lib/portfolio/positions";
import type { IndexedOrder, MarketView, PositionView } from "@/types/api";

export interface HeaderPortfolioSummary {
  cashAvailable: number;
  netPortfolioValue: number | null;
}

/** Display-only USD estimate. Quote assets are treated as $1, matching the
 * product's current quote semantics; conditional claims require a real mark. */
export function headerPortfolioSummary(
  markets: MarketView[],
  balances: WalletAssetBalance[],
  positions: PositionView[],
  orders: IndexedOrder[],
): HeaderPortfolioSummary {
  const quoteTokens = new Set(markets.map((market) => market.quoteToken));
  let cashAvailable = 0;
  let netPortfolioValue = 0;
  let netKnown = true;

  for (const asset of balances) {
    const available = tokenAmount(asset.balance.vaultAvailable, asset.decimals);
    const reserved = tokenAmount(asset.balance.reserved, asset.decimals);
    const isQuote = quoteTokens.has(asset.token);
    if (isQuote) cashAvailable += available;
    const reference = isQuote ? 1 : asset.reference;
    if (reference === null && available + reserved > 0) netKnown = false;
    else netPortfolioValue += (available + reserved) * (reference ?? 0);
  }

  for (const row of conditionalPositionRows(markets, positions, orders)) {
    // Issuer claims are raw token units; the book marks economic shares, which
    // the leg's live multiplier converts (1 for quote claims).
    const quantity = tokenAmount(row.total.toString(), row.decimals) * row.multiplier;
    const probability = row.market.probability.value;
    const quoteMark =
      probability !== null && Number.isFinite(probability) && probability >= 0 && probability <= 1
        ? row.branch === 0
          ? probability
          : 1 - probability
        : null;
    const mark =
      row.kind === "stock"
        ? midpoint(row.branch === 0 ? row.market.yes : row.market.no)
        : quoteMark;
    if (mark === null || !Number.isFinite(mark) || mark < 0) netKnown = false;
    else netPortfolioValue += quantity * mark;
  }

  return { cashAvailable, netPortfolioValue: netKnown ? netPortfolioValue : null };
}
