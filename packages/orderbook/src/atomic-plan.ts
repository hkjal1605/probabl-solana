import {
  hashOrder,
  type Order,
  quoteForExecution,
  quoteForReservation,
  Side,
  TimeInForce,
} from "@conditional-stocks/domain";
import type { Address, Hex } from "viem";

export const MAX_ATOMIC_MAKERS = 32;
export const ATOMIC_EXECUTION_VERSION = 2;
export const MAX_ATOMIC_RELEASES = 32;
export const ATOMIC_QUOTE_TTL_SECONDS = 60n;

export interface MatchCandidate {
  order: Order;
  orderHash: Hex;
  remaining: bigint;
  sequence: bigint;
}

export interface AtomicPlan {
  guard: { nextSequence: bigint; makerFeeBps: number; takerFeeBps: number };
  releaseOrders: Hex[];
  makers: Order[];
  quantities: bigint[];
  expectedRemaining: bigint[];
  deadline: bigint;
  filledQuantity: bigint;
  remainingQuantity: bigint;
  executionQuote: bigint;
}

export class AtomicPlanError extends Error {
  override readonly name = "AtomicPlanError";
}

/** Pure price/FIFO candidate selection. No leases, reservations, signatures, or broadcasting. */
export function planAtomicOrder(input: {
  taker: Order;
  candidates: readonly MatchCandidate[];
  chainId: bigint;
  exchange: Address;
  timestamp: bigint;
  baseStep: bigint;
  makerFeeBps: number;
  takerFeeBps: number;
  nextSequence: bigint;
}): AtomicPlan {
  const { taker, timestamp, baseStep } = input;
  const maximum = (1n << 128n) - 1n;
  if (
    baseStep <= 0n ||
    input.nextSequence < 0n ||
    input.nextSequence >= 1n << 64n ||
    taker.quantity <= 0n ||
    taker.quantity > maximum ||
    taker.quantity % baseStep !== 0n ||
    taker.limitPriceRawX18 <= 0n ||
    taker.limitPriceRawX18 > maximum ||
    taker.expiry <= timestamp ||
    ![Side.Buy, Side.Sell].includes(taker.side) ||
    ![TimeInForce.Gtc, TimeInForce.Ioc].includes(taker.tif) ||
    ![0, 1].includes(taker.branch) ||
    [input.makerFeeBps, input.takerFeeBps, taker.maxFeeBps].some(
      (fee) => !Number.isInteger(fee) || fee < 0 || fee > 1000,
    )
  )
    throw new AtomicPlanError("Invalid atomic order terms");
  // The query uses the same bound and filters before LIMIT; the extra row detects a
  // sweep that needs another transaction. Never silently discard an arbitrary tail.
  if (input.candidates.length > MAX_ATOMIC_MAKERS + 1)
    throw new AtomicPlanError("Candidate response exceeds the bounded book window");

  const seen = new Set<string>();
  const sequences = new Set<bigint>();
  const eligible = input.candidates.filter((candidate) => {
    const { order, remaining, sequence, orderHash } = candidate;
    const id = orderHash.toLowerCase();
    if (seen.has(id)) throw new AtomicPlanError("Duplicate maker in candidate response");
    seen.add(id);
    if (sequences.has(sequence))
      throw new AtomicPlanError("Canonical makers have duplicate sequence numbers");
    sequences.add(sequence);
    if (
      hashOrder(order, {
        chainId: input.chainId,
        verifyingContract: input.exchange,
      }).toLowerCase() !== id ||
      order.marketId.toLowerCase() !== taker.marketId.toLowerCase() ||
      order.branch !== taker.branch ||
      ![Side.Buy, Side.Sell].includes(order.side) ||
      order.side === taker.side ||
      order.tif !== TimeInForce.Gtc ||
      order.quantity <= 0n ||
      order.quantity > maximum ||
      order.quantity % baseStep !== 0n ||
      !Number.isInteger(order.maxFeeBps) ||
      order.maxFeeBps < 0 ||
      order.maxFeeBps > 1000 ||
      remaining <= 0n ||
      remaining > order.quantity ||
      remaining > maximum ||
      remaining % baseStep !== 0n ||
      sequence < 0n ||
      sequence >= input.nextSequence ||
      order.limitPriceRawX18 <= 0n ||
      order.limitPriceRawX18 > maximum
    )
      throw new AtomicPlanError("Invalid canonical maker candidate");
    return (
      order.expiry > timestamp &&
      order.maxFeeBps >= input.makerFeeBps &&
      (taker.side === Side.Buy
        ? order.limitPriceRawX18 <= taker.limitPriceRawX18
        : order.limitPriceRawX18 >= taker.limitPriceRawX18)
    );
  });
  eligible.sort((a, b) => {
    const left = a.order.limitPriceRawX18;
    const right = b.order.limitPriceRawX18;
    if (left !== right) return (left < right ? -1 : 1) * (taker.side === Side.Buy ? 1 : -1);
    if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
    throw new AtomicPlanError("Canonical makers have duplicate sequence numbers");
  });

  let remainingQuantity = taker.quantity;
  let executionQuote = 0n;
  const makers: Order[] = [];
  const quantities: bigint[] = [];
  const expectedRemaining: bigint[] = [];
  for (const candidate of eligible) {
    if (remainingQuantity === 0n) break;
    if (makers.length === MAX_ATOMIC_MAKERS)
      throw new AtomicPlanError("Order crosses more than 32 makers; reduce the order quantity");
    const quantity =
      remainingQuantity < candidate.remaining ? remainingQuantity : candidate.remaining;
    const quote = quoteForExecution(quantity, candidate.order.limitPriceRawX18);
    if (quote === 0n)
      throw new AtomicPlanError("Fill rounds to zero quote; increase the trade quantity");
    makers.push(candidate.order);
    quantities.push(quantity);
    expectedRemaining.push(candidate.remaining);
    remainingQuantity -= quantity;
    executionQuote += quote;
  }
  if (makers.length > 0 && taker.maxFeeBps < input.takerFeeBps)
    throw new AtomicPlanError("Signed fee cap is below the current taker fee");
  const deadline = makers.reduce(
    (earliest, maker) => (maker.expiry < earliest ? maker.expiry : earliest),
    timestamp + ATOMIC_QUOTE_TTL_SECONDS < taker.expiry
      ? timestamp + ATOMIC_QUOTE_TTL_SECONDS
      : taker.expiry,
  );
  return {
    guard: {
      nextSequence: input.nextSequence,
      makerFeeBps: input.makerFeeBps,
      takerFeeBps: input.takerFeeBps,
    },
    releaseOrders: [],
    makers,
    quantities,
    expectedRemaining,
    deadline,
    filledQuantity: taker.quantity - remainingQuantity,
    remainingQuantity,
    executionQuote,
  };
}

export interface StaleReservation {
  orderHash: Hex;
  maker: Address;
  marketId: Hex;
  openNotional: bigint;
}

/** Computes final resting exposure without rescaling raw units or charging executed exposure. */
export function atomicRestingNotional(input: {
  taker: Order;
  plan: AtomicPlan;
  marketOpenNotional: bigint;
  walletOpenNotional: bigint;
}) {
  const { taker, plan } = input;
  if (input.walletOpenNotional < 0n || input.marketOpenNotional < input.walletOpenNotional)
    throw new AtomicPlanError("Inconsistent canonical open notional");
  const resting =
    taker.tif === TimeInForce.Ioc
      ? 0n
      : quoteForReservation(plan.remainingQuantity, taker.limitPriceRawX18);
  let market = input.marketOpenNotional + resting;
  let wallet = input.walletOpenNotional + resting;
  for (const [i, maker] of plan.makers.entries()) {
    const before = plan.expectedRemaining[i];
    const fill = plan.quantities[i];
    if (before === undefined || fill === undefined || fill > before || fill <= 0n)
      throw new AtomicPlanError("Malformed fill for cap accounting");
    const reduction =
      quoteForReservation(before, maker.limitPriceRawX18) -
      quoteForReservation(before - fill, maker.limitPriceRawX18);
    market -= reduction;
    if (maker.maker.toLowerCase() === taker.maker.toLowerCase()) wallet -= reduction;
  }
  if (wallet < 0n || market < wallet)
    throw new AtomicPlanError("Inconsistent canonical open notional");
  return { market, wallet };
}

/** Only stale reservations needed for cap space are included; never clean arbitrary live orders. */
export function planAtomicRecovery(input: {
  taker: Order;
  resting: { market: bigint; wallet: bigint };
  maxMarketOpenNotional: bigint;
  maxWalletOpenNotional: bigint;
  candidates: readonly StaleReservation[];
}) {
  if (input.candidates.length > MAX_ATOMIC_RELEASES + 1)
    throw new AtomicPlanError("Stale reservation response exceeds the bounded window");
  const { taker } = input;
  let { market, wallet } = input.resting;
  if (
    wallet < 0n ||
    market < wallet ||
    input.maxWalletOpenNotional <= 0n ||
    input.maxMarketOpenNotional < input.maxWalletOpenNotional
  )
    throw new AtomicPlanError("Invalid resting exposure or cap configuration");
  const seen = new Set<string>();
  const candidates = input.candidates
    .map((candidate) => {
      const hash = candidate.orderHash.toLowerCase();
      if (
        seen.has(hash) ||
        candidate.marketId.toLowerCase() !== taker.marketId.toLowerCase() ||
        candidate.openNotional <= 0n ||
        candidate.openNotional >= 1n << 128n
      )
        throw new AtomicPlanError("Invalid stale reservation candidate");
      seen.add(hash);
      return candidate;
    })
    .sort(
      (a, b) =>
        Number(b.maker.toLowerCase() === taker.maker.toLowerCase()) -
        Number(a.maker.toLowerCase() === taker.maker.toLowerCase()),
    );
  const releaseOrders: Hex[] = [];
  for (const candidate of candidates) {
    if (market <= input.maxMarketOpenNotional && wallet <= input.maxWalletOpenNotional) break;
    const own = candidate.maker.toLowerCase() === taker.maker.toLowerCase();
    if (!own && market <= input.maxMarketOpenNotional) continue;
    if (releaseOrders.length === MAX_ATOMIC_RELEASES) break;
    market -= candidate.openNotional;
    if (own) wallet -= candidate.openNotional;
    if (wallet < 0n || market < wallet)
      throw new AtomicPlanError("Inconsistent stale reservation accounting");
    releaseOrders.push(candidate.orderHash);
  }
  if (wallet > input.maxWalletOpenNotional || market > input.maxMarketOpenNotional)
    throw new AtomicPlanError(
      "Final resting order exceeds open-order caps; reduce its remainder or recover more stale orders first",
    );
  return { releaseOrders, market, wallet };
}
