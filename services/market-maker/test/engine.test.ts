import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  baseRaw,
  bn,
  claimAsset,
  fundingAsset,
  key,
  legBit,
  multiplierBits,
  orderId,
  orderTerms,
  orderWire,
  planOrder,
  singleBase,
  UNIT_MULTIPLIER,
  underlyingAsset,
  walletAddress,
  type LiveLeg,
  type OrderAccount,
  type OrderWire,
  type SolanaClient,
  type WalletAccount,
} from "@conditional-stocks/solana-client";
import {
  Engine,
  foreignBook,
  inventory,
  owned,
  passiveOrder,
  quoteChange,
  reservation,
  targetShares,
} from "../src/engine";
import { settings } from "../src/config";
import { initialState } from "../src/state";
import type { Executor } from "../src/execution";
import {
  NVDA,
  USDC,
  book,
  config,
  custody,
  id,
  legs,
  market,
  marketAccount,
  order,
  owner,
  paused,
  policy,
  reference,
  seeded,
} from "./fixtures";

const setWallet = (s: ReturnType<typeof book>, balances: bigint[]) =>
  s.wallets.set(walletAddress(key(id), owner, s.program).toBase58(), {
    balances: balances.map(bn),
  } as WalletAccount);
const bid = (branch: 0 | 1 = 0, bases = 7) => ({
  branch,
  side: 0 as const,
  level: 0,
  price: BigInt(order().terms.price.toString()),
  quantity: 1000000n,
  bases,
});

/** Applies cancels and placements to the snapshot like the program: a placement
 * moves its reservation out of the wallet, a cancellation returns it. */
function chain(s: ReturnType<typeof book>, live: () => Record<number, LiveLeg>) {
  const wallet = () => s.wallets.get(walletAddress(key(id), owner, s.program).toBase58())!;
  const move = (asset: number, amount: bigint) =>
    (wallet().balances[asset] = bn(BigInt(wallet().balances[asset]!.toString()) + amount));
  return async (instructions: any[]) => {
    for (const ix of instructions)
      if (ix.kind === "cancel") {
        const o = s.orders.get(ix.order)!;
        move(fundingAsset(orderWire(o)), BigInt(o.reserved.toString()));
        s.orders.delete(ix.order);
      } else if (ix.kind === "place") {
        const o = ix.o as OrderWire,
          reserved = reservation(
            {
              side: o.side,
              bases: o.bases,
              price: BigInt(o.limitPriceRawX18),
              quantity: BigInt(o.quantity),
            },
            live(),
          );
        move(fundingAsset(o), -reserved);
        expect(BigInt(wallet().balances[fundingAsset(o)]!.toString())).toBeGreaterThanOrEqual(0n);
        s.orders.set(orderId(o, s.program), {
          market: key(o.marketId),
          owner: key(o.maker),
          delegate: PublicKey.default,
          terms: orderTerms(o),
          remaining: bn(o.quantity),
          filled: bn(0),
          reserved: bn(reserved),
          open_notional: bn(0),
          sequence: bn(0),
          fee_carry: 0,
          status: 1,
          bump: 0,
        });
      }
  };
}

test("funding allocates shared credit once per issuer pool, deposits only each market's shortfall, and skips paused issuers", async () => {
  const s = book(),
    other = PublicKey.unique().toBase58();
  s.markets.set(other, marketAccount({ market: key(other) }));
  custody(s, owner, { [USDC]: 200n, [NVDA.x]: 100n });
  const policies = [id, other].map((market) => ({
    ...policy,
    market,
    quoteInventory: "0.00015",
    orderQuote: "0.00003",
    // 60 raw NVDAx, 1000 raw NVDAon (paused), nothing of NVDAr.
    baseInventories: ["0.0000006", "0.000001", "0"],
  }));
  const deposits: [number, bigint][] = [],
    sent: string[] = [];
  const credit = (mint: string) =>
    [...s.credits.values()].find((c) => String(s.pools.get(String(c.pool))!.mint) === mint)!;
  const client = {
    program: s.program,
    deployment: { genesisHash: "test" },
    rememberMarket: () => {},
    initializeWallet: () => ({ kind: "wallet" }),
    depositForCredit: async (
      _market: unknown,
      _owner: unknown,
      mint: PublicKey,
      asset: number,
      amount: bigint,
    ) => {
      deposits.push([asset, amount]);
      return { gross: amount, fee: 0n, instruction: { kind: "deposit", mint: String(mint), amount } };
    },
    positionCredit: (_market: unknown, _owner: unknown, collateral: number) => ({
      kind: "credit",
      collateral,
    }),
    position: (
      _action: unknown,
      market: PublicKey,
      _owner: unknown,
      collateral: number,
      amount: bigint,
    ) => ({
      kind: "split",
      market: String(market),
      collateral,
      mint: String(s.markets.get(String(market))!.mints[underlyingAsset(collateral)]),
      amount,
    }),
  } as unknown as SolanaClient;
  const executor = {
    reconcilePending: async () => {},
    send: async (instructions: any[]) => {
      // The idempotent credit initializer always directly precedes the split.
      expect(instructions.at(-2)).toEqual({
        kind: "credit",
        collateral: instructions.at(-1).collateral,
      });
      for (const ix of instructions) {
        if (ix.kind === "deposit") {
          const c = credit(ix.mint);
          c.available = bn(BigInt(c.available.toString()) + ix.amount);
        } else if (ix.kind === "split") {
          const c = credit(ix.mint),
            previous = BigInt(c.available.toString());
          expect(previous).toBeGreaterThanOrEqual(ix.amount);
          c.available = bn(previous - ix.amount);
          sent.push(`${ix.market}:${ix.collateral}`);
        }
      }
    },
  } as unknown as Executor;
  const state = initialState("test"),
    engine = new Engine(
      client,
      owner,
      { ...config, markets: policies },
      "https://example.com",
      state,
      () => {},
      executor,
      async () => reference,
    );
  engine.view = async () => s;
  engine.validateMarket = async (_s, p) => s.markets.get(p.market)!;
  engine.legs = async () => legs({ 2: paused });
  // Whole-asset credits must not appear in each market's conditional risk inventory.
  for (const p of policies) expect(inventory(s, owner, p.market).every((v) => v === 0n)).toBe(true);
  await engine.fund();
  for (const p of policies)
    expect(state.markets[p.market]).toMatchObject({
      fundStarted: true,
      fundComplete: true,
      spot: String(reference.spot),
      probability: String(reference.probability),
      observedAt: reference.observedAt,
    });
  // Quote pool (asset 0) and NVDAx pool (asset 3) shortfalls of the second market only.
  expect(deposits).toEqual([
    [0, 100n],
    [3, 20n],
  ]);
  expect(sent).toEqual([`${id}:0`, `${id}:1`, `${other}:0`, `${other}:1`]);
  expect([...s.credits.values()].map((c) => c.available.toString())).toEqual(["0", "0"]);
});
test("inventory is twelve assets, includes escrow once and never includes another wallet", () => {
  const s = book();
  setWallet(s, seeded());
  const ask = order(1, 1, legBit(2));
  s.orders.set("bid", order());
  s.orders.set("ask", ask);
  s.orders.set("foreign", { ...order(), owner: key(policy.quoteMint) });
  const expected = seeded();
  expected[1]! += 1000000n;
  expected[claimAsset(2, 1)]! += 1000000n;
  expect(inventory(s, owner, id)).toEqual(expected);
  expect(inventory(s, owner, id)).toHaveLength(12);
  expect(owned(s, owner, id)).toHaveLength(2);
});
test("targets default to the seeded issuers at live multipliers, or an explicit share position", () => {
  expect(targetShares(policy, market, legs())).toBe(3_000_000n);
  expect(targetShares(policy, market, legs({ 1: { multiplier: multiplierBits(1.1) } }))).toBe(
    3_100_000n,
  );
  const quoteOnly = { ...policy, baseInventories: ["0", "0", "0"], targetShares: "2.5" };
  expect(targetShares(quoteOnly, market, legs())).toBe(2_500_000n);
  expect(reservation({ side: 1, bases: legBit(1), price: 1n, quantity: 10_000n }, legs())).toBe(
    1_000_000n,
  );
  expect(reservation({ side: 1, bases: legBit(2), price: 1n, quantity: 10_000n }, legs())).toBe(
    10_000_000n,
  );
});
test("quote diff removes duplicates, expired and disallowed orders, and atomically replaces only changed slots", () => {
  const o = order(),
    q = bid();
  expect(quoteChange([["a", o]], [q], 1n, config)).toBeUndefined();
  expect(quoteChange([["a", o]], [], 1n, config)).toEqual({ cancel: "a" });
  expect(quoteChange([], [q], 1n, config)).toEqual({ quote: q });
  expect(
    quoteChange(
      [
        ["a", o],
        ["b", o],
      ],
      [q],
      1n,
      config,
    ),
  ).toEqual({ cancel: "b" });
  expect(quoteChange([["a", o]], [{ ...q, quantity: 999999n }], 1n, config)?.cancel).toBe("a");
  expect(
    quoteChange([["a", { ...o, terms: { ...o.terms, funding: 0 } }]], [q], 1n, config),
  ).toEqual({ cancel: "a" });
});
test("ranked quote diff retains independent bid and per-issuer ask ladder levels", () => {
  const ladder = {
    bid: [1_000_000n, 900_000n, 800_000n].map((price, level) => ({
      ...bid(),
      level,
      price,
    })),
    ask: [1_100_000n, 1_200_000n].map((price, level) => ({
      branch: 0 as const,
      side: 1 as const,
      level,
      price,
      quantity: 1_000_000n,
      bases: legBit(1),
    })),
  };
  // A second issuer's ask ladder at the same prices is independent.
  const other = ladder.ask.map((q) => ({ ...q, bases: legBit(3) }));
  const desired = [...ladder.bid, ...ladder.ask, ...other];
  const resting = (price: bigint, side: number, bases?: number) => ({
    ...order(0, side, bases),
    terms: { ...order(0, side, bases).terms, price: bn(price) },
  });
  const current: [string, ReturnType<typeof order>][] = [
    ["outer-bid", resting(800_000n, 0)],
    ["best-bid", resting(1_000_000n, 0)],
    ["mid-bid", resting(900_000n, 0)],
    ["outer-ask", resting(1_200_000n, 1)],
    ["best-ask", resting(1_100_000n, 1)],
    ["r-best", resting(1_100_000n, 1, legBit(3))],
    ["r-outer", resting(1_200_000n, 1, legBit(3))],
  ];
  expect(quoteChange(current, desired, 1n, config)).toBeUndefined();
  expect(quoteChange(current.slice(1), desired, 1n, config)).toEqual({ quote: ladder.bid[2]! });
  expect(quoteChange(current, [...ladder.bid, ladder.ask[0]!, ...other], 1n, config)).toEqual({
    cancel: "outer-ask",
  });
  expect(quoteChange(current.slice(0, 5), desired, 1n, config)).toEqual({ quote: other[0]! });
  const changed = [...desired];
  changed[1] = { ...changed[1]!, price: 700_000n };
  expect(quoteChange(current, changed, 1n, config)).toEqual({
    cancel: "mid-bid",
    quote: changed[1],
  });
});
test("halted issuers: bids narrow to tradable legs, resting asks on the halted leg are cancelled", () => {
  const narrowed = bid(0, 0b101);
  // A resting consolidated bid still accepting the halted leg is replaced.
  expect(quoteChange([["a", order()]], [narrowed], 1n, config)).toEqual({
    cancel: "a",
    quote: narrowed,
  });
  // A resting NVDAon ask with no desired NVDAon ask is cancelled.
  const ask = order(0, 1, legBit(2));
  expect(quoteChange([["a", order(0, 0, 0b101)], ["b", ask]], [narrowed], 1n, config)).toEqual({
    cancel: "b",
  });
});
test("an ask whose reservation no longer covers the live multiplier is re-reserved", () => {
  const ask = order(0, 1, legBit(1)),
    reserved = baseRaw(1_000_000n, 100n, UNIT_MULTIPLIER, true);
  const resting: OrderAccount = { ...ask, reserved: bn(reserved) };
  const q = {
    branch: 0 as const,
    side: 1 as const,
    level: 0,
    price: BigInt(ask.terms.price.toString()),
    quantity: 1_000_000n,
    bases: legBit(1),
  };
  const live = (multiplier: bigint) => ({
    makerBps: 10,
    minimumNonce: 0n,
    legs: legs({ 1: { multiplier } }),
  });
  expect(quoteChange([["a", resting]], [q], 1n, config, live(UNIT_MULTIPLIER))).toBeUndefined();
  // A dividend (higher multiplier) needs fewer raw tokens: still deliverable.
  expect(
    quoteChange([["a", resting]], [q], 1n, config, live(multiplierBits(1.05))),
  ).toBeUndefined();
  // A lower multiplier needs more raw tokens than reserved.
  expect(quoteChange([["a", resting]], [q], 1n, config, live(multiplierBits(0.95)))).toEqual({
    cancel: "a",
    quote: q,
  });
});
test("passive orders use own recipient, conditional funding, leg masks, bounded expiry, no matching legs, and fresh salts", () => {
  const s = book(),
    q = { ...bid(), price: reference.spot };
  const a = passiveOrder(owner, id, market, s, q, 120, 1000n),
    b = passiveOrder(owner, id, market, s, q, 120, 1000n);
  expect(a.recipient).toBe(a.maker);
  expect(a.fundingKind).toBe(1);
  expect(a.tif).toBe(0);
  expect(a.bases).toBe(7);
  expect(a.salt).not.toBe(b.salt);
  expect(a.expiry).toBe("1120");
  const plan = planOrder({
    order: a,
    candidates: [],
    now: 1000n,
    step: 10000n,
    nextSequence: 0n,
    makerFeeBps: 10,
    takerFeeBps: 20,
    legs: legs(),
  });
  expect(plan.makers).toEqual([]);
  expect(plan.filledQuantity).toBe("0");
  expect(orderTerms(a).funding).toBe(1);
  // An ask funds from exactly its issuer's claim of its branch.
  const ask = passiveOrder(owner, id, market, s, { ...q, branch: 1, side: 1, bases: legBit(3) }, 120, 1000n);
  expect(fundingAsset(ask)).toBe(claimAsset(3, 1));
  expect(() =>
    planOrder({
      order: ask,
      candidates: [],
      now: 1000n,
      step: 10000n,
      nextSequence: 0n,
      makerFeeBps: 10,
      takerFeeBps: 20,
      legs: legs({ 3: paused }),
    }),
  ).toThrow("halted");
});
test("foreign book tops are per issuer: bids count on every accepted leg, asks on their one leg", () => {
  const s = book(),
    stranger = PublicKey.unique();
  s.wallets.set(walletAddress(key(id), stranger, s.program).toBase58(), {
    balances: seeded().map(bn),
  } as WalletAccount);
  s.traders.set(stranger.toBase58(), { minimum_nonce: bn(0) } as never);
  const foreign = (side: number, bases: number, price: bigint) => ({
    ...order(0, side, bases),
    owner: stranger,
    terms: { ...order(0, side, bases).terms, price: bn(price) },
  });
  s.orders.set("b1", foreign(0, 0b011, 90n));
  s.orders.set("b2", foreign(0, 0b100, 95n));
  s.orders.set("a2", foreign(1, 0b010, 110n));
  s.orders.set("a2b", foreign(1, 0b010, 105n));
  s.orders.set("mine", order(0, 1, 0b001));
  expect(foreignBook(s, owner, id)).toEqual([
    { 1: { bid: 90n }, 2: { bid: 90n, ask: 105n }, 3: { bid: 95n } },
    {},
  ]);
});
test("risk state halts on marked inventory drawdown, pauses jumps, and rejects time regression", () => {
  const s = book();
  setWallet(s, seeded());
  const state = initialState("test"),
    engine = new Engine(
      {} as SolanaClient,
      owner,
      config,
      "https://example.com",
      state,
      () => {},
      {} as Executor,
    );
  engine.plan(s, market, policy, { ...reference, observedAt: Date.now() }, legs());
  expect(BigInt(state.markets[id]!.peak!)).toBeGreaterThan(0n);
  expect(() =>
    engine.plan(
      s,
      market,
      policy,
      { ...reference, spot: reference.spot / 2n, observedAt: Date.now() },
      legs(),
    ),
  ).toThrow();
  expect(state.markets[id]!.halted).toBe(true);
  expect(() =>
    engine.plan(s, market, policy, { ...reference, observedAt: Date.now() }, legs()),
  ).toThrow();
  const clean = initialState("test"),
    dry = new Engine({} as SolanaClient, owner, config, "https://example.com", clean, () => {});
  const quotes = dry.plan(s, market, policy, { ...reference, observedAt: Date.now() }, legs());
  // Dry-run assumes the configured seed: one consolidated bid and three issuer asks per branch.
  expect(quotes).toHaveLength(8);
  expect(() => dry.plan(s, market, policy, { ...reference, observedAt: 1 }, legs())).toThrow();
});

test("repeated execution reads do not decay volatility and churn the same quote within a cycle", () => {
  const state = initialState("test"),
    engine = new Engine({} as SolanaClient, owner, config, "https://example.com", state, () => {}),
    s = book();
  engine.plan(s, market, policy, { ...reference, observedAt: Date.now() }, legs());
  const moved = { ...reference, spot: (reference.spot * 101n) / 100n, observedAt: Date.now() };
  const first = engine.plan(s, market, policy, moved, legs()),
    vol = state.markets[id]!.movement;
  for (let i = 0; i < 5; i++) expect(engine.plan(s, market, policy, moved, legs())).toEqual(first);
  expect(state.markets[id]!.movement).toBe(vol);
});

test("fee changes, nonce invalidation and foreign recipients cannot leave unusable/donating quotes", () => {
  const o = order(),
    q = bid();
  expect(quoteChange([["a", o]], [q], 1n, config, { makerBps: 20, minimumNonce: 0n })).toEqual({
    cancel: "a",
    quote: q,
  });
  expect(quoteChange([["a", o]], [q], 1n, config, { makerBps: 10, minimumNonce: 1n })).toEqual({
    cancel: "a",
    quote: q,
  });
  expect(
    quoteChange(
      [["a", { ...o, terms: { ...o.terms, recipient: key(policy.quoteMint) } }]],
      [q],
      1n,
      config,
    ),
  ).toEqual({ cancel: "a" });
});

test("partial funding is journaled before sending and cannot automatically top up or retry", async () => {
  const s = book(),
    state = initialState("test");
  let sends = 0;
  const client = {
    program: s.program,
    rememberMarket: () => {},
    deployment: { genesisHash: "test" },
    depositForCredit: async () => ({ gross: 100000000n, fee: 0n, instruction: {} }),
    wallet: async () => null,
    initializeWallet: () => ({}),
    positionCredit: () => ({}),
    position: () => ({}),
  } as unknown as SolanaClient;
  const executor = {
    reconcilePending: async () => {},
    send: async () => {
      sends++;
      expect(state.markets[id]?.fundStarted).toBe(true);
      throw new Error("ambiguous send");
    },
  } as unknown as Executor;
  const engine = new Engine(
    client,
    owner,
    config,
    "https://example.com",
    state,
    () => {},
    executor,
    async () => reference,
  );
  engine.view = async () => s;
  engine.validateMarket = async () => market;
  engine.legs = async () => legs();
  await expect(engine.fund()).rejects.toThrow();
  expect(sends).toBe(1);
  await expect(engine.fund()).rejects.toThrow("Funding already attempted");
  expect(sends).toBe(1);
});

function staticEngine(s: ReturnType<typeof book>, live: () => Record<number, LiveLeg> = legs) {
  const state = initialState("test"),
    placed: OrderWire[] = [];
  state.markets[id] = { fundStarted: true, fundComplete: true };
  let references = 0,
    saves = 0;
  const client = {
    program: s.program,
    deployment: { genesisHash: "test" },
    placement: (o: OrderWire) => {
      placed.push(o);
      return { kind: "place", o };
    },
  } as unknown as SolanaClient;
  const apply = chain(s, live);
  const executor = {
    reconcilePending: async () => {},
    send: async (instructions: unknown[], _maintenance: boolean, valid: () => boolean) => {
      expect(valid()).toBe(true);
      await apply(instructions);
    },
  } as unknown as Executor;
  const engine = new Engine(
    client,
    owner,
    config,
    "https://example.com",
    state,
    () => saves++,
    executor,
    async () => {
      references++;
      return reference;
    },
  );
  engine.view = async () => s;
  engine.validateMarket = async () => market;
  engine.legs = async () => live();
  return {
    engine,
    state,
    placed,
    get references() {
      return references;
    },
    get saves() {
      return saves;
    },
  };
}
test("static placement refreshes and journals its bounded reference before signing", async () => {
  const s = book();
  setWallet(s, seeded());
  const f = staticEngine(s);
  await f.engine.staticCycle();
  expect(f.references).toBe(1);
  // Two consolidated bids plus one ask per seeded issuer per branch.
  expect(f.placed).toHaveLength(8);
  expect(f.placed.filter((o) => o.side === 0).map((o) => o.bases)).toEqual([7, 7]);
  expect(f.placed.filter((o) => o.side === 1).map((o) => singleBase(o.bases)).sort()).toEqual([
    1, 1, 2, 2, 3, 3,
  ]);
  expect(f.saves).toBe(1);
  expect(f.state.markets[id]).toMatchObject({
    fundComplete: true,
    spot: String(reference.spot),
    probability: String(reference.probability),
    observedAt: reference.observedAt,
  });
});
test("static placement leaves a paused issuer out of both sides", async () => {
  const s = book();
  setWallet(s, seeded());
  const f = staticEngine(s, () => legs({ 2: paused }));
  await f.engine.staticCycle();
  expect(f.placed).toHaveLength(6);
  expect(f.placed.filter((o) => o.side === 0).every((o) => o.bases === 0b101)).toBe(true);
  expect(f.placed.some((o) => o.side === 1 && o.bases === legBit(2))).toBe(false);
});

test("static placement resumes by ladder counts without repricing or duplicating a full book", async () => {
  const s = book();
  for (const branch of [0, 1]) {
    s.orders.set(`${branch}:bid`, order(branch, 0));
    for (const c of [1, 2, 3]) s.orders.set(`${branch}:${c}`, order(branch, 1, legBit(c)));
  }
  let sends = 0;
  const f = staticEngine(s);
  (f.engine.executor as unknown as { send: () => void }).send = () => sends++;
  await f.engine.staticCycle();
  expect(f.references).toBe(0);
  expect(sends).toBe(0);
});

test("static placement honors shutdown before reading another market", async () => {
  let views = 0;
  const engine = new Engine(
    {} as SolanaClient,
    owner,
    config,
    "https://example.com",
    initialState("test"),
    () => {},
    { reconcilePending: async () => {} } as Executor,
  );
  engine.stopped = true;
  engine.view = async () => {
    views++;
    return book();
  };
  await engine.staticCycle();
  expect(views).toBe(0);
});

test("live cycle quotes one book for every issuer, then cancels a halted issuer's asks and narrows bids", async () => {
  const s = book();
  setWallet(s, seeded());
  s.traders.set(owner.toBase58(), { minimum_nonce: bn(0) } as never);
  let live = legs();
  const maintenance: unknown[] = [];
  const client = {
    program: s.program,
    deployment: { genesisHash: "test" },
    cancel: async (order: PublicKey) => ({ kind: "cancel", order: order.toBase58() }),
    placement: (o: OrderWire) => ({ kind: "place", o }),
    orderMaintenance: (...args: unknown[]) => maintenance.push(args),
    rememberMarket: () => {},
  } as unknown as SolanaClient;
  const apply = chain(s, () => live);
  const executor = {
    reconcilePending: async () => {},
    send: async (instructions: any[]) => apply(instructions),
  } as unknown as Executor;
  const engine = new Engine(
    client,
    owner,
    settings({ markets: [policy] }),
    "https://example.com",
    initialState("test"),
    () => {},
    executor,
    async () => ({ ...reference, observedAt: Date.now() }),
  );
  engine.view = async () => s;
  engine.validateMarket = async () => market;
  engine.legs = async () => live;
  const book0 = () => owned(s, owner, id).map(([, o]) => o.terms);
  await engine.cycle();
  expect(maintenance).toEqual([]);
  expect(book0().filter((t) => t.side === 0).map((t) => t.bases)).toEqual([7, 7]);
  expect(book0().filter((t) => t.side === 1)).toHaveLength(6);
  live = legs({ 2: paused });
  await engine.cycle();
  expect(maintenance).toEqual([]);
  expect(book0().filter((t) => t.side === 0).map((t) => t.bases)).toEqual([0b101, 0b101]);
  const asks = book0().filter((t) => t.side === 1);
  expect(asks.map((t) => singleBase(t.bases)).sort()).toEqual([1, 1, 3, 3]);
});

test("legacy raw-unit spot checkpoints are not compared with per-share spot", () => {
  const state = initialState("test"),
    engine = new Engine({} as SolanaClient, owner, config, "https://example.com", state, () => {}),
    s = book();
  // A pre-multi-issuer checkpoint: spot per raw base unit, 100x smaller.
  state.markets[id] = { spot: String(reference.spot / 100n), probability: "400000", observedAt: 1 };
  engine.plan(s, market, policy, { ...reference, observedAt: Date.now() }, legs());
  expect(state.markets[id]!.cooldownUntil).toBeUndefined();
  expect(state.markets[id]!.priceUnit).toBe("share");
  // Later per-share observations are compared as before.
  expect(() =>
    engine.plan(
      s,
      market,
      policy,
      { ...reference, spot: reference.spot * 2n, observedAt: Date.now() },
      legs(),
    ),
  ).toThrow("circuit breaker");
});
