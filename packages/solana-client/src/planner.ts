import {
  MAX_MAKERS,
  acceptsLeg,
  baseRaw,
  orderCollateral,
  orderId,
  parseOrder,
  quote,
  unsigned,
  U64_MAX,
  type OrderWire,
  type PublicKey,
} from "./protocol.ts";

export interface Candidate {
  order: OrderWire;
  orderHash: string;
  remaining: bigint;
  sequence: bigint;
  /** Current raw reservation of a maker ask; enables the reserve-sufficiency check. */
  reserved?: bigint;
}
/** Live state of a base leg, indexed by collateral (1..=MAX_BASES). */
export interface LegState {
  /** 10^(leg decimals - share decimals). */
  scale: bigint;
  /** Live ScaledUiAmount multiplier bits (1.0 when absent). */
  multiplier: bigint;
  /** Listed, active, claims ready, unpaused, unfrozen, multiplier within band. */
  tradable: boolean;
}
export interface AtomicPlan {
  guard: { nextSequence: string; makerFeeBps: number; takerFeeBps: number };
  makers: OrderWire[];
  /** Planned share units per maker. On chain a maker filled, cancelled or
   * invalidated since planning is skipped and a partially filled one capped. */
  quantities: string[];
  /** Each maker's remaining at planning (credit-frame decisions, review). */
  expectedRemaining: string[];
  /** Least total fill for the placement to proceed: one step for
   * immediate-or-cancel orders (otherwise a no-op), zero for resting ones. */
  minFill?: string;
  deadline: string;
  filledQuantity: string;
  remainingQuantity: string;
  executionQuote: string;
  /** Per maker: a completing ask returns a reservation surplus, so its pool
   * credit frame must be included. Omitted when unknown (then every completing
   * underlying-funded ask gets a frame). */
  surplus?: boolean[];
}

/** The source's independent-book, best-price/FIFO planner, using exact Solana identities. */
export function planOrder(input: {
  order: OrderWire;
  candidates: Candidate[];
  now: bigint;
  step: bigint;
  nextSequence: bigint;
  makerFeeBps: number;
  takerFeeBps: number;
  program?: PublicKey;
  /** Live leg state by collateral. Without it every leg is assumed tradable. */
  legs?: Partial<Record<number, LegState>>;
  /** Account-budget cap below MAX_MAKERS (multi-leg fills use more accounts). */
  maxMakers?: number;
}): AtomicPlan {
  const taker = parseOrder(input.order);
  const maxMakers = input.maxMakers ?? MAX_MAKERS;
  if (!Number.isInteger(maxMakers) || maxMakers < 0 || maxMakers > MAX_MAKERS)
    throw new Error("Invalid maker cap");
  const leg = (collateral: number) => input.legs?.[collateral];
  const tradable = (collateral: number) => !input.legs || leg(collateral)?.tradable === true;
  if (taker.side === 1 && !tradable(orderCollateral(taker)))
    throw new Error("This issuer leg is halted: delisted, paused, frozen or past a corporate action");
  if (
    input.step <= 0n ||
    unsigned(taker.quantity) % input.step !== 0n ||
    unsigned(taker.expiry) <= input.now ||
    input.nextSequence < 0n ||
    input.nextSequence >= U64_MAX
  )
    throw new Error("Invalid order or book sequence");
  for (const fee of [input.makerFeeBps, input.takerFeeBps])
    if (!Number.isInteger(fee) || fee < 0 || fee > 1_000) throw new Error("Invalid fee rate");
  const seen = new Set<string>(),
    sequences = new Set<bigint>();
  const eligible = input.candidates
    .filter((c) => {
      const o = parseOrder(c.order);
      if (
        seen.has(c.orderHash) ||
        sequences.has(c.sequence) ||
        c.orderHash !== orderId(o, input.program) ||
        o.marketId !== taker.marketId ||
        o.branch !== taker.branch ||
        o.side === taker.side ||
        o.tif !== 0 ||
        c.remaining <= 0n ||
        c.remaining > unsigned(o.quantity) ||
        c.remaining % input.step !== 0n ||
        c.sequence < 0n ||
        c.sequence >= input.nextSequence
      )
        throw new Error("Invalid canonical candidate");
      seen.add(c.orderHash);
      sequences.add(c.sequence);
      // A bid matches an ask only when it accepts the ask's issuer leg, and
      // only tradable legs can deliver.
      const base = orderCollateral(o.side === 1 ? o : taker);
      const bid = o.side === 0 ? o : taker;
      return (
        acceptsLeg(bid, base) &&
        tradable(base) &&
        BigInt(o.expiry) > input.now &&
        o.maxFeeBps >= input.makerFeeBps &&
        (taker.side === 0
          ? BigInt(o.limitPriceRawX18) <= BigInt(taker.limitPriceRawX18)
          : BigInt(o.limitPriceRawX18) >= BigInt(taker.limitPriceRawX18))
      );
    })
    .sort((a, b) => {
      const ap = BigInt(a.order.limitPriceRawX18),
        bp = BigInt(b.order.limitPriceRawX18);
      return ap !== bp
        ? (ap < bp ? -1 : 1) * (taker.side === 0 ? 1 : -1)
        : a.sequence < b.sequence
          ? -1
          : 1;
    });
  let remaining = BigInt(taker.quantity),
    execution = 0n;
  let deadline = input.now + 60n < BigInt(taker.expiry) ? input.now + 60n : BigInt(taker.expiry);
  const makers: OrderWire[] = [],
    quantities: string[] = [],
    expectedRemaining: string[] = [],
    surplus: boolean[] = [];
  let surplusKnown = true;
  for (const c of eligible) {
    if (remaining === 0n) break;
    if (makers.length === maxMakers) {
      // Immediate-or-cancel fills what one transaction can carry and releases
      // the rest (its on-chain semantics). A resting order would rest crossed.
      if (taker.tif === 1) break;
      throw new Error(`Order crosses more than ${maxMakers} makers; reduce quantity`);
    }
    const amount = remaining < c.remaining ? remaining : c.remaining;
    let refund = false;
    if (c.order.side === 1) {
      const l = leg(orderCollateral(c.order));
      if (l && c.reserved !== undefined) {
        // An ask whose reservation no longer covers the live conversion (a
        // multiplier that fell within its band) cannot deliver; skip it.
        const raw = baseRaw(amount, l.scale, l.multiplier);
        if (raw > c.reserved) continue;
        refund = amount === c.remaining && c.reserved > raw;
      } else surplusKnown = false;
    }
    const payment = quote(amount, BigInt(c.order.limitPriceRawX18));
    if (payment === 0n) throw new Error("Fill rounds to zero quote");
    makers.push(c.order);
    surplus.push(refund);
    quantities.push(amount.toString());
    expectedRemaining.push(c.remaining.toString());
    remaining -= amount;
    execution += payment;
    if (BigInt(c.order.expiry) < deadline) deadline = BigInt(c.order.expiry);
  }
  if (makers.length && taker.maxFeeBps < input.takerFeeBps)
    throw new Error("Order fee cap is below the taker rate");
  return {
    guard: {
      nextSequence: input.nextSequence.toString(),
      makerFeeBps: input.makerFeeBps,
      takerFeeBps: input.takerFeeBps,
    },
    makers,
    quantities,
    expectedRemaining,
    minFill: (taker.tif === 1 && makers.length ? input.step : 0n).toString(),
    deadline: deadline.toString(),
    filledQuantity: (BigInt(taker.quantity) - remaining).toString(),
    remainingQuantity: remaining.toString(),
    executionQuote: execution.toString(),
    ...(surplusKnown ? { surplus } : {}),
  };
}

export function parseAtomicPlan(value: unknown, order: OrderWire): AtomicPlan {
  if (!value || typeof value !== "object") throw new Error("Missing execution plan");
  const p = value as AtomicPlan;
  if (
    !Array.isArray(p.makers) ||
    !Array.isArray(p.quantities) ||
    !Array.isArray(p.expectedRemaining) ||
    p.makers.length > MAX_MAKERS ||
    p.makers.length !== p.quantities.length ||
    p.makers.length !== p.expectedRemaining.length ||
    (p.surplus !== undefined &&
      (!Array.isArray(p.surplus) || p.surplus.length !== p.makers.length || p.surplus.some((v) => typeof v !== "boolean"))) ||
    !p.guard
  )
    throw new Error("Invalid execution plan");
  const candidates = p.makers.map((maker, i) => ({
    order: parseOrder(maker),
    orderHash: orderId(parseOrder(maker)),
    remaining: unsigned(p.expectedRemaining[i]),
    sequence: BigInt(i),
  }));
  unsigned(p.guard.nextSequence);
  const minFill = p.minFill === undefined ? 0n : unsigned(p.minFill);
  // Validate the reviewed legs independently of untrusted aggregate totals.
  let remaining = BigInt(order.quantity),
    execution = 0n;
  const seen = new Set<string>();
  for (const [i, c] of candidates.entries()) {
    const quantity = unsigned(p.quantities[i]);
    if (
      seen.has(c.orderHash) ||
      quantity === 0n ||
      quantity > c.remaining ||
      quantity > remaining ||
      c.remaining > BigInt(c.order.quantity) ||
      c.order.marketId !== order.marketId ||
      c.order.branch !== order.branch ||
      c.order.side === order.side ||
      c.order.tif !== 0 ||
      !acceptsLeg(order.side === 0 ? order : c.order, orderCollateral(order.side === 1 ? order : c.order)) ||
      c.order.maxFeeBps < p.guard.makerFeeBps ||
      (order.side === 0
        ? BigInt(c.order.limitPriceRawX18) > BigInt(order.limitPriceRawX18)
        : BigInt(c.order.limitPriceRawX18) < BigInt(order.limitPriceRawX18))
    )
      throw new Error("Invalid maker leg");
    seen.add(c.orderHash);
    remaining -= quantity;
    execution += quote(quantity, BigInt(c.order.limitPriceRawX18));
  }
  for (const fee of [p.guard.makerFeeBps, p.guard.takerFeeBps])
    if (!Number.isInteger(fee) || fee < 0 || fee > 1_000) throw new Error("Invalid fee guard");
  if (p.makers.length && p.guard.takerFeeBps > order.maxFeeBps)
    throw new Error("Taker fee exceeds cap");
  if (
    unsigned(p.deadline) > BigInt(order.expiry) ||
    remaining !== unsigned(p.remainingQuantity) ||
    BigInt(order.quantity) - remaining !== unsigned(p.filledQuantity) ||
    minFill > BigInt(order.quantity) - remaining ||
    execution !== unsigned(p.executionQuote)
  )
    throw new Error("Plan totals or expiry differ");
  return p;
}
