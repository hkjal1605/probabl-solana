/** Number of price rows that fit above and below the midpoint without scrolling. */
export function visibleDepthPerSide(
  availableHeight: number,
  headerHeight: number,
  rowHeight: number,
): number {
  if (
    !Number.isFinite(availableHeight) ||
    !Number.isFinite(headerHeight) ||
    !Number.isFinite(rowHeight) ||
    availableHeight <= 0 ||
    headerHeight < 0 ||
    rowHeight <= 0
  )
    return 1;
  return Math.max(1, Math.floor((availableHeight - headerHeight - rowHeight) / (2 * rowHeight)));
}

export interface DepthLevel {
  priceExact: string;
  price: number;
  /** Shares at this level matching the issuer filter. */
  quantity: number;
  /** Running share total from the best price outward. */
  cumulative: number;
  /** Issuer-leg mask present at the level (asks: delivering legs, bids: accepted legs); 0 when unknown. */
  mask: number;
  /** Bids only: the level includes bids accepting every listed issuer. */
  anyIssuer: boolean;
}

/**
 * Visible depth for one book side, optionally filtered to one issuer set. Asks
 * count only the shares of matching issuers; bids count only bids accepting a
 * matching issuer. Totals are in shares, never raw issuer units, so levels of
 * different issuers (and decimals) aggregate exactly as the program matches them.
 */
export function depthLevels(
  levels: readonly {
    priceExact: string;
    price: number;
    quantity: number;
    byBases?: readonly { mask: number; quantity: number }[];
  }[],
  count: number,
  filter: number | null,
  listed: number,
): DepthLevel[] {
  const result: DepthLevel[] = [];
  let cumulative = 0;
  for (const level of levels) {
    if (result.length >= Math.max(0, Math.floor(count))) break;
    const entries = level.byBases;
    const matching = entries
      ? entries.filter((entry) => filter === null || (entry.mask & filter) !== 0)
      : null;
    const quantity = matching
      ? matching.reduce((total, entry) => total + entry.quantity, 0)
      : level.quantity;
    if (!(quantity > 0)) continue;
    cumulative += quantity;
    const mask = (matching ?? []).reduce((all, entry) => all | entry.mask, 0);
    result.push({
      priceExact: level.priceExact,
      price: level.price,
      quantity,
      cumulative,
      mask,
      anyIssuer: listed > 0 && (matching ?? []).some((entry) => (entry.mask & listed) === listed),
    });
  }
  return result;
}
