import {
  MAX_MAKERS,
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
}
export interface AtomicPlan {
  guard: { nextSequence: string; makerFeeBps: number; takerFeeBps: number };
  makers: OrderWire[];
  quantities: string[];
  expectedRemaining: string[];
  deadline: string;
  filledQuantity: string;
  remainingQuantity: string;
  executionQuote: string;
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
}): AtomicPlan {
  const taker = parseOrder(input.order);
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
      return (
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
    expectedRemaining: string[] = [];
  for (const c of eligible) {
    if (remaining === 0n) break;
    if (makers.length === MAX_MAKERS)
      throw new Error(`Order crosses more than ${MAX_MAKERS} makers; reduce quantity`);
    const amount = remaining < c.remaining ? remaining : c.remaining;
    const payment = quote(amount, BigInt(c.order.limitPriceRawX18));
    if (payment === 0n) throw new Error("Fill rounds to zero quote");
    makers.push(c.order);
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
    deadline: deadline.toString(),
    filledQuantity: (BigInt(taker.quantity) - remaining).toString(),
    remainingQuantity: remaining.toString(),
    executionQuote: execution.toString(),
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
    execution !== unsigned(p.executionQuote)
  )
    throw new Error("Plan totals or expiry differ");
  return p;
}
