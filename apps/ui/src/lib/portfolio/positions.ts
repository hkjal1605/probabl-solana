import { legStatus, orderLeg } from "@/lib/markets/legs";
import type { IndexedOrder, MarketLegView, MarketView, PositionView } from "@/types/api";

export interface ConditionalPositionRow {
  available: bigint;
  branch: 0 | 1;
  /** 0 = quote claims, 1..=3 = the issuer leg's claims. */
  collateral: number;
  /** Raw decimals of the claim mint (the leg's or the quote's decimals). */
  decimals: number;
  key: string;
  kind: "quote" | "stock";
  leg: MarketLegView | null;
  market: MarketView;
  /** Economic shares per whole claim token (live multiplier; 1 for quote claims). */
  multiplier: number;
  reserved: bigint;
  symbol: string;
  total: bigint;
}

/** Open claim-funded (fundingKind 1) reservations of one market, branch and collateral. */
const reservedClaims = (
  orders: IndexedOrder[],
  marketId: string,
  branch: 0 | 1,
  collateral: number,
) =>
  orders
    .filter(
      (order) =>
        order.marketId === marketId &&
        order.branch === branch &&
        order.fundingKind === 1 &&
        order.status === "open" &&
        (collateral === 0 ? order.side === 0 : orderLeg(order) === collateral),
    )
    .reduce((sum, order) => sum + BigInt(order.reserved), 0n);

/**
 * Per-issuer YES/NO rows (claims are segregated per issuer: NVDAx-YES is backed
 * only by NVDAx) plus the market's quote YES/NO rows. Amounts are raw units of
 * each claim's own mint.
 */
export function conditionalPositionRows(
  markets: MarketView[],
  positions: PositionView[],
  orders: IndexedOrder[],
): ConditionalPositionRow[] {
  const stockRows = markets.flatMap((market) => {
    const position = positions.find((item) => item.marketId === market.id);
    return market.bases.flatMap((leg) => {
      const held = position?.bases.find((item) => item.collateral === leg.collateral);
      const multiplier = legStatus(leg).multiplierValue;
      return ([0, 1] as const).map((branch) => {
        const available = BigInt((branch === 0 ? held?.yes : held?.no) ?? "0");
        const reserved = reservedClaims(orders, market.id, branch, leg.collateral);
        return {
          available,
          branch,
          collateral: leg.collateral,
          decimals: leg.decimals,
          key: `stock-${market.id}-${leg.collateral}-${branch}`,
          kind: "stock" as const,
          leg,
          market,
          multiplier,
          reserved,
          symbol: leg.symbol,
          total: available + reserved,
        };
      });
    });
  });

  // Even sibling markets for the same event have distinct quote-claim mints.
  const quoteRows = markets.flatMap((market) => {
    const position = positions.find((item) => item.marketId === market.id);
    return ([0, 1] as const).map((branch) => {
      const available = BigInt((branch === 0 ? position?.quoteYes : position?.quoteNo) ?? "0");
      const reserved = reservedClaims(orders, market.id, branch, 0);
      return {
        available,
        branch,
        collateral: 0,
        decimals: market.quoteTokenDecimals,
        key: `quote-${market.id}-${branch}`,
        kind: "quote" as const,
        leg: null,
        market,
        multiplier: 1,
        reserved,
        symbol: market.quoteTokenMetadata?.symbol ?? "USDC",
        total: available + reserved,
      };
    });
  });

  return [...stockRows, ...quoteRows].filter((row) => row.total > 0n);
}
