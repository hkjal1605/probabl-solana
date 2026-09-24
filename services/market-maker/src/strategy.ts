import {
  ASSETS,
  baseRaw,
  big,
  claimAsset,
  legBit,
  legsOf,
  multiplierParts,
  quote,
  underlyingAsset,
  U128_MAX,
  U64_MAX,
  WAD,
  type LegState,
  type MarketAccount,
} from "@conditional-stocks/solana-client";
import { abs, BPS, ceil, max, min, PROB, type Settings } from "./config.ts";

export interface Quote {
  branch: 0 | 1;
  side: 0 | 1;
  level: number;
  /** Quote raw per share unit x 1e18. */
  price: bigint;
  /** Share units. */
  quantity: bigint;
  /** Leg mask: every accepted leg for a bid, exactly one delivered leg for an ask. */
  bases: number;
}
export interface Reference {
  /** Quote raw per share unit x 1e18. */
  spot: bigint;
  probability: bigint;
  observedAt: number;
  spread: bigint;
  /** Per-leg spot that contributed to `spot` (informational). */
  legs?: Record<number, bigint>;
}
/** Live leg state by collateral (1..=bases), from the SDK's `liveLegs`. */
export type Legs = Partial<Record<number, LegState>>;
/** Best foreign bid/ask per leg: a bid counts on every leg it accepts. */
export interface Top {
  bid?: bigint;
  ask?: bigint;
}
export type Book = [Record<number, Top>, Record<number, Top>];

/** Share units fully backed by `raw` issuer units at a live multiplier:
 * floor(raw * mantissa / (scale * 2^shift)). Inverse of the SDK's `baseRaw`, so
 * `baseRaw(shareUnits(raw), up = true) <= raw` always holds. */
export function shareUnits(raw: bigint, scale: bigint, multiplier: bigint): bigint {
  if (raw < 0n || raw > U64_MAX || scale <= 0n) throw new Error("Invalid share conversion");
  const { mantissa, shift } = multiplierParts(multiplier);
  return (raw * mantissa) / (scale << shift);
}
/** Mask of the market's currently tradable legs. */
export function tradableMask(bases: number, legs: Legs): number {
  let mask = 0;
  for (let c = 1; c <= bases; c++) if (legs[c]?.tradable) mask |= legBit(c);
  return mask;
}
function leg(legs: Legs, c: number): LegState {
  const l = legs[c];
  if (!l) throw new Error("Missing live leg state");
  return l;
}
export function fairPrices(spot: bigint, p: bigint, gapBps: number): [bigint, bigint] {
  if (
    spot <= 0n ||
    spot > U128_MAX ||
    p <= 0n ||
    p >= PROB ||
    !Number.isInteger(gapBps) ||
    Math.abs(gapBps) > 7500
  )
    throw new Error("Invalid fair-price input");
  const gap = (spot * BigInt(gapBps)) / BPS;
  // Sy = S + (1-p)D; Sn = S - pD. Rounding error is below one raw X18 unit.
  const yes = spot + ((PROB - p) * gap) / PROB,
    no = spot - (p * gap) / PROB;
  if (yes <= 0n || no <= 0n || yes > U128_MAX || no > U128_MAX)
    throw new Error("Fair price out of bounds");
  return [yes, no];
}
/** Marked inventory in quote raw units. Issuer balances are raw units of their own
 * mint, converted to share units at each leg's live multiplier. */
export function equity(
  balances: bigint[],
  reference: Reference,
  gapBps: number,
  bases: number,
  legs: Legs,
): bigint {
  const [yes, no] = fairPrices(reference.spot, reference.probability, gapBps),
    p = reference.probability;
  let total = balances[0]! + (balances[1]! * p + balances[2]! * (PROB - p)) / PROB;
  for (let c = 1; c <= bases; c++) {
    const l = leg(legs, c),
      shares = (asset: number) => shareUnits(balances[asset]!, l.scale, l.multiplier);
    total +=
      quote(shares(underlyingAsset(c)), reference.spot) +
      (quote(shares(claimAsset(c, 0)), yes) * p +
        quote(shares(claimAsset(c, 1)), no) * (PROB - p)) /
        PROB;
  }
  return total;
}
export function quotes(input: {
  market: MarketAccount;
  reference: Reference;
  gapBps: number;
  /** ASSETS raw balances (wallet plus own reservations). */
  balances: bigint[];
  legs: Legs;
  /** Reference branch position across all legs, in share units. */
  targetShares: bigint;
  orderQuote: bigint;
  makerBps: number;
  movementBps: bigint;
  settings: Settings;
  best: Book;
}): Quote[] {
  const {
    market: m,
    reference: r,
    settings: s,
    balances: b,
    targetShares: target,
    orderQuote: notional,
  } = input;
  const tick = big(m.terms.tick),
    step = big(m.terms.step);
  if (
    tick <= 0n ||
    step <= 0n ||
    target <= 0n ||
    b.length !== ASSETS ||
    b.some((v) => v < 0n || v > U64_MAX) ||
    notional <= 0n ||
    !Number.isInteger(input.makerBps) ||
    input.makerBps < 0 ||
    input.makerBps > 1000
  )
    throw new Error("Invalid quote inputs");
  const fair = fairPrices(r.spot, r.probability, input.gapBps);
  const uncertainty = ceil(r.spread * BigInt(Math.abs(input.gapBps)), PROB);
  // Sellers receive quote net of fees: 1+f is insufficient at large fee rates.
  const feeEdge = ceil(BigInt(input.makerBps) * BPS, BPS - BigInt(input.makerBps));
  const half = max(
    BigInt(s.halfSpreadBps),
    feeEdge + BigInt(s.adverseSelectionBps) + input.movementBps * 2n + uncertainty,
  );
  if (half > BigInt(s.maxHalfSpreadBps)) return [];
  const totalBudget = min(
    notional,
    big(m.terms.max_order) * BigInt(s.quoteLevels),
    big(m.terms.max_wallet) / 4n,
    big(m.terms.max_market) / 4n,
  );
  const tradable = tradableMask(m.bases, input.legs);
  const output: Quote[] = [];
  const ladder = (o: {
    branch: 0 | 1;
    side: 0 | 1;
    bases: number;
    /** Share units still allowed on this ladder (bids: buying room). */
    room: bigint;
    /** Bids: quote claim cash. Asks: raw claim units of the delivered leg. */
    funds: bigint;
    budget: bigint;
    skew: bigint;
    crosses: (price: bigint) => boolean;
    convert?: LegState;
  }) => {
    const center = fair[o.branch];
    let remainingRoom = o.room,
      remainingFunds = o.funds,
      remainingBudget = o.budget,
      previousPrice: bigint | undefined;
    for (let level = 0; level < s.quoteLevels; level++) {
      const edge = half + BigInt(s.levelSpacingBps * level);
      if (edge > BigInt(s.maxHalfSpreadBps)) break;
      const price =
          o.side === 0
            ? ((center * (BPS - edge)) / BPS / tick) * tick
            : ceil(ceil(center * (BPS + edge), BPS), tick) * tick,
        levelsLeft = s.quoteLevels - level,
        // Slightly larger outer levels make displayed depth realistic without
        // multiplying the configured per-side budget. The narrow weighting
        // keeps the innermost level above common minimum notionals.
        weight = BigInt(2 * s.quoteLevels + 5 + level),
        remainingWeight = BigInt(
          (levelsLeft * (2 * (2 * s.quoteLevels + 5 + level) + levelsLeft - 1)) / 2,
        ),
        budget = (remainingBudget * weight) / remainingWeight;
      if (price <= 0n || price > U128_MAX) continue;
      // Tick rounding must not turn two ladder levels into the same book price.
      if (price === previousPrice) continue;
      // A deeper level may remain passive even when an inner level would cross.
      if (o.crosses(price)) continue;
      // Asks: every order reserves its own rounded-up raw amount, so recompute the
      // backed share units from the raw claims still unreserved.
      const room = o.convert
        ? min(remainingRoom, shareUnits(remainingFunds, o.convert.scale, o.convert.multiplier))
        : remainingRoom;
      let amount =
        (min(
          (budget * WAD) / price,
          (big(m.terms.max_order) * WAD) / price,
          big(m.terms.max_quantity),
          room,
        ) *
          o.skew) /
        BPS;
      if (o.side === 0) amount = min(amount, (remainingFunds * WAD) / price);
      amount = (amount / step) * step;
      if (
        amount <= 0n ||
        amount > U64_MAX ||
        quote(amount, price) < big(m.terms.min_notional) ||
        quote(amount, price, true) > big(m.terms.max_order) ||
        quote(amount, price, true) > budget
      )
        continue;
      const reserved = o.convert
        ? baseRaw(amount, o.convert.scale, o.convert.multiplier, true)
        : quote(amount, price, true);
      if (reserved > remainingFunds) continue;
      output.push({
        branch: o.branch,
        side: o.side,
        level,
        price,
        quantity: amount,
        bases: o.bases,
      });
      previousPrice = price;
      remainingRoom -= amount;
      remainingBudget -= quote(amount, price, true);
      remainingFunds -= reserved;
    }
  };
  for (const branch of [0, 1] as const) {
    const top = input.best[branch],
      held: bigint[] = [];
    let heldTotal = 0n;
    for (let c = 1; c <= m.bases; c++) {
      const l = leg(input.legs, c);
      held[c] = shareUnits(b[claimAsset(c, branch)]!, l.scale, l.multiplier);
      heldTotal += held[c]!;
    }
    // One consolidated bid per level accepts every tradable leg. Inventory risk is
    // the branch position across issuers; centers stay on parity.
    if (tradable) {
      const room = max(0n, 2n * target - heldTotal),
        bestAsk = legsOf(tradable)
          .map((c) => top[c]?.ask)
          .filter((v): v is bigint => v !== undefined);
      ladder({
        branch,
        side: 0,
        bases: tradable,
        room,
        funds: b[claimAsset(0, branch)]!,
        budget: totalBudget,
        skew: min(BPS, (room * BPS) / target),
        crosses: (price) => bestAsk.some((ask) => price >= ask),
      });
    }
    // Asks deliver one issuer each, sized by that issuer's claims. The side budget
    // is shared across issuers in proportion to their holdings.
    const sellers = legsOf(tradable).filter((c) => held[c]! > 0n),
      askable = sellers.reduce((sum, c) => sum + held[c]!, 0n);
    for (const c of sellers) {
      const bid = top[c]?.bid;
      ladder({
        branch,
        side: 1,
        bases: legBit(c),
        room: held[c]!,
        funds: b[claimAsset(c, branch)]!,
        budget: (totalBudget * held[c]!) / askable,
        skew: min(BPS, (heldTotal * BPS) / target),
        crosses: (price) => bid !== undefined && price <= bid,
        convert: leg(input.legs, c),
      });
    }
  }
  return output;
}
export function needsReplace(
  old: { price: bigint; remaining: bigint; expiry: bigint },
  desired: Quote,
  now: bigint,
  s: Settings,
) {
  return (
    old.expiry <= now + BigInt(Math.ceil(s.pollMs / 1000) * 2) ||
    abs(old.price - desired.price) * BPS >= desired.price * BigInt(s.repriceBps) ||
    abs(old.remaining - desired.quantity) * 4n >= max(old.remaining, desired.quantity)
  );
}
