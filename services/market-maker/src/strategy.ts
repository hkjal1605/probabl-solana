import {
  big,
  quote,
  U128_MAX,
  U64_MAX,
  WAD,
  type MarketAccount,
} from "@conditional-stocks/solana-client";
import { abs, BPS, ceil, max, min, PROB, type Settings } from "./config.ts";

export interface Quote {
  branch: 0 | 1;
  side: 0 | 1;
  price: bigint;
  quantity: bigint;
}
export interface Reference {
  spot: bigint;
  probability: bigint;
  observedAt: number;
  spread: bigint;
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
export function equity(balances: bigint[], reference: Reference, gapBps: number): bigint {
  const [yes, no] = fairPrices(reference.spot, reference.probability, gapBps),
    p = reference.probability;
  return (
    quote(balances[0]!, reference.spot) +
    balances[1]! +
    (quote(balances[2]!, yes) * p +
      quote(balances[3]!, no) * (PROB - p) +
      balances[4]! * p +
      balances[5]! * (PROB - p)) /
      PROB
  );
}
export function quotes(input: {
  market: MarketAccount;
  reference: Reference;
  gapBps: number;
  balances: bigint[];
  targetBase: bigint;
  orderQuote: bigint;
  makerBps: number;
  movementBps: bigint;
  settings: Settings;
  best: [{ bid?: bigint; ask?: bigint }, { bid?: bigint; ask?: bigint }];
}): Quote[] {
  const {
    market: m,
    reference: r,
    settings: s,
    balances: b,
    targetBase: target,
    orderQuote: notional,
  } = input;
  const tick = big(m.terms.tick),
    step = big(m.terms.step);
  if (
    tick <= 0n ||
    step <= 0n ||
    target <= 0n ||
    b.length !== 6 ||
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
  const output: Quote[] = [];
  for (const branch of [0, 1] as const) {
    const center = fair[branch],
      held = b[2 + branch]!,
      cash = b[4 + branch]!;
    const bid = ((center * (BPS - half)) / BPS / tick) * tick;
    const ask = ceil(ceil(center * (BPS + half), BPS), tick) * tick;
    if (bid <= 0n || ask > U128_MAX || ask <= bid) continue;
    for (const side of [0, 1] as const) {
      const price = side === 0 ? bid : ask,
        best = input.best[branch];
      // Do not chase somebody else's quote or cross a known book. Omit that side instead.
      if (
        (side === 0 && best.ask !== undefined && price >= best.ask) ||
        (side === 1 && best.bid !== undefined && price <= best.bid)
      )
        continue;
      // Keep centers on parity; inventory risk changes size, not the fair-price constraint.
      const room = side === 0 ? max(0n, 2n * target - held) : held;
      const skew = min(BPS, (room * BPS) / target);
      const budget = min(
        notional,
        big(m.terms.max_order),
        big(m.terms.max_wallet) / 4n,
        big(m.terms.max_market) / 4n,
      );
      let amount = (min((budget * WAD) / price, big(m.terms.max_quantity), room) * skew) / BPS;
      if (side === 0) amount = min(amount, (cash * WAD) / price);
      amount = (amount / step) * step;
      if (
        amount <= 0n ||
        amount > U64_MAX ||
        quote(amount, price) < big(m.terms.min_notional) ||
        quote(amount, price, true) > budget
      )
        continue;
      output.push({ branch, side, price, quantity: amount });
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
