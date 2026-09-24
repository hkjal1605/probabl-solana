import { formatShareAmount, formatTokenAmount } from "@conditional-stocks/domain";
import {
  baseRaw,
  type LegHalt,
  multiplierParts,
  multiplierValue,
  singleBase,
  UNIT_MULTIPLIER,
  withinBand,
} from "@conditional-stocks/solana-client";
import type { BookLevel, BranchBook, IndexedOrder, MarketLegView, MarketView } from "@/types/api";

/** Unlisted asset slots in the 12-entry mint table. */
export const DEFAULT_MINT = "11111111111111111111111111111111";

export const HALT_REASONS: Record<LegHalt, string> = {
  delisted: "Delisted by the market admin",
  "claims-uninitialized": "Claims are not initialized yet",
  "issuer-paused": "Paused by the issuer",
  "vault-frozen": "Protocol vault frozen by the issuer",
  "corporate-action": "Halted after a corporate action (multiplier outside the dividend band)",
  "transfer-hook": "Issuer enabled a transfer hook",
  unreadable: "Issuer state is unavailable",
};

export interface LegStatus {
  leg: MarketLegView;
  collateral: number;
  bit: number;
  tradable: boolean;
  halt: LegHalt | null;
  reason: string | null;
  /** Live multiplier bits used for conversion (listing multiplier when live state is unknown). */
  multiplier: bigint;
  multiplierValue: number;
  /** Whether `multiplier` came from a live issuer read. */
  liveKnown: boolean;
  scale: bigint;
}

const bits = (value: string | undefined, fallback = UNIT_MULTIPLIER) => {
  try {
    return value && /^[0-9]{1,20}$/.test(value) ? BigInt(value) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Tradability of a leg for new exposure. Live issuer state (from the indexer/API)
 * is authoritative when present; otherwise listing state decides and the program
 * remains the final check.
 */
export function legStatus(leg: MarketLegView): LegStatus {
  const listing = bits(leg.listingMultiplier);
  const live = leg.live;
  const multiplier = live ? bits(live.multiplier, listing) : listing;
  let halt: LegHalt | null = live?.halt ?? null;
  if (!halt) {
    if (!leg.active) halt = "delisted";
    else if (!leg.ready) halt = "claims-uninitialized";
    else if (live?.paused) halt = "issuer-paused";
    else if (live?.vaultFrozen) halt = "vault-frozen";
    else {
      try {
        if (!withinBand(listing, multiplier)) halt = "corporate-action";
      } catch {
        halt = "unreadable";
      }
    }
  }
  const tradable = halt === null && (live ? live.tradable : true);
  let value = 1;
  try {
    value = live?.multiplierValue ?? multiplierValue(multiplier);
  } catch {
    /* Display only. */
  }
  return {
    leg,
    collateral: leg.collateral,
    bit: leg.bit,
    tradable,
    halt: tradable ? null : (halt ?? "unreadable"),
    reason: tradable ? null : HALT_REASONS[halt ?? "unreadable"],
    multiplier,
    multiplierValue: value,
    liveKnown: Boolean(live),
    scale: BigInt(leg.scale),
  };
}

export const legStatuses = (market: Pick<MarketView, "bases">) => market.bases.map(legStatus);

export const legByCollateral = (market: Pick<MarketView, "bases">, collateral: number) =>
  market.bases.find((leg) => leg.collateral === collateral);

/** Every listed leg (for display filters). */
export const listedMask = (market: Pick<MarketView, "bases">) =>
  market.bases.reduce((mask, leg) => mask | leg.bit, 0);

/** Default buy acceptance: every tradable leg. Zero when no leg is tradable. */
export const defaultBuyMask = (market: Pick<MarketView, "bases">) =>
  legStatuses(market).reduce((mask, status) => (status.tradable ? mask | status.bit : mask), 0);

/** Buy acceptance mask from a user selection, restricted to tradable legs. */
export function buyMask(market: Pick<MarketView, "bases">, selected: readonly number[] | null) {
  if (selected === null) return defaultBuyMask(market);
  return legStatuses(market).reduce(
    (mask, status) =>
      status.tradable && selected.includes(status.collateral) ? mask | status.bit : mask,
    0,
  );
}

export const maskLegs = (market: Pick<MarketView, "bases">, mask: number) =>
  market.bases.filter((leg) => (mask & leg.bit) !== 0);

/**
 * Default sell leg: the tradable leg the user holds the most of in the chosen
 * funding asset, else the first tradable leg.
 */
export function defaultSellLeg(
  market: Pick<MarketView, "bases">,
  holdings: Readonly<Record<number, bigint>>,
): number | null {
  const tradable = legStatuses(market).filter((status) => status.tradable);
  let best: { collateral: number; amount: bigint } | null = null;
  for (const status of tradable) {
    const amount = holdings[status.collateral] ?? 0n;
    if (amount > 0n && (!best || amount > best.amount))
      best = { collateral: status.collateral, amount };
  }
  return best?.collateral ?? tradable[0]?.collateral ?? null;
}

/** Raw issuer units a sell of `quantity` share units reserves (rounded up), at the leg's live multiplier. */
export function sellReservation(quantity: bigint, status: Pick<LegStatus, "scale" | "multiplier">) {
  return baseRaw(quantity, status.scale, status.multiplier, true);
}

/** Raw issuer units delivered for `quantity` share units (rounded down). */
export function deliveredRaw(quantity: bigint, status: Pick<LegStatus, "scale" | "multiplier">) {
  return baseRaw(quantity, status.scale, status.multiplier, false);
}

/**
 * Largest step-aligned share quantity whose rounded-up reservation fits `raw`
 * leg units (e.g. to close a claim position or sell a full token balance).
 * Exact: ceil(q * scale * 2^shift / mantissa) <= raw  <=>  q * scale * 2^shift <= raw * mantissa.
 */
export function sharesForRaw(
  raw: bigint,
  status: Pick<LegStatus, "scale" | "multiplier">,
  step: bigint,
): bigint {
  if (raw <= 0n || step <= 0n || status.scale <= 0n) return 0n;
  const { mantissa, shift } = multiplierParts(status.multiplier);
  const maximum = (raw * mantissa) / (status.scale << shift);
  return (maximum / step) * step;
}

/** The leg a sell order delivers. */
export const orderLeg = (order: Pick<IndexedOrder, "side" | "bases" | "baseCollateral">) =>
  order.side === 1 ? (order.baseCollateral ?? singleBase(order.bases ?? 0)) : null;

/** A level's portion that matches `mask`. Levels without an issuer breakdown match any mask. */
export function levelQuantity(level: BookLevel, mask: number | null): number {
  if (mask === null || !level.byBases) return level.quantity;
  return level.byBases.reduce(
    (total, entry) => ((entry.mask & mask) !== 0 ? total + entry.quantity : total),
    0,
  );
}

/**
 * Best executable price for an order on one book side. A buy accepting `mask`
 * can take asks of any leg in it; a sell of leg c can hit bids accepting c.
 */
export function bestLevelFor(
  book: BranchBook,
  side: "buy" | "sell",
  mask: number | null,
): BookLevel | null {
  const levels = side === "buy" ? book.asks : book.bids;
  return levels.find((level) => levelQuantity(level, mask) > 0) ?? null;
}

/** Legs present at an ask level (single-bit masks) or accepted at a bid level. */
export function levelLegs(market: Pick<MarketView, "bases">, level: BookLevel): MarketLegView[] {
  if (!level.byBases) return [];
  const mask = level.byBases.reduce((all, entry) => all | entry.mask, 0);
  return maskLegs(market, mask);
}

export const formatShares = (quantity: bigint, market: MarketView) =>
  formatShareAmount(quantity, market);

export const formatLegRaw = (raw: bigint, leg: Pick<MarketLegView, "decimals">) =>
  formatTokenAmount(raw, leg.decimals);

/** Human label for an issuer set: "All issuers", "NVDAx + NVDAon", or "No issuer". */
export function maskLabel(market: Pick<MarketView, "bases">, mask: number) {
  const legs = maskLegs(market, mask);
  if (!legs.length) return "No issuer";
  if (legs.length === market.bases.length && legs.length > 1) return "Any issuer";
  return legs.map((leg) => leg.symbol).join(" + ");
}

/** Mint of an asset index from the market's 12-entry table (null when unlisted). */
export function assetMint(market: Pick<MarketView, "claimMints">, asset: number): string | null {
  const mint = market.claimMints[asset];
  return mint && mint !== DEFAULT_MINT ? mint : null;
}
