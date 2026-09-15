import { expect, test } from "bun:test";
import {
  bn,
  key,
  walletAddress,
  orderTerms,
  type WalletAccount,
  type SolanaClient,
  planOrder,
} from "@conditional-stocks/solana-client";
import { Engine, inventory, quoteChange, passiveOrder, owned } from "../src/engine";
import { initialState } from "../src/state";
import type { Executor } from "../src/execution";
import { config, market, policy, reference, book, owner, id, order } from "./fixtures";
test("inventory includes escrow once and never includes another wallet", () => {
  const s = book();
  s.wallets.set(walletAddress(key(id), owner, s.program).toBase58(), {
    balances: [0, 0, 100, 100, 100, 100].map(bn),
  } as WalletAccount);
  const bid = order(),
    ask = order(1, 1);
  s.orders.set("bid", bid);
  s.orders.set("ask", ask);
  s.orders.set("foreign", { ...bid, owner: key(policy.quoteMint) });
  expect(inventory(s, owner, id)).toEqual([0n, 0n, 100n, 1000100n, 1000100n, 100n]);
  expect(owned(s, owner, id)).toHaveLength(2);
});
test("quote diff removes duplicates, expired and disallowed orders, and atomically replaces only changed slots", () => {
  const o = order(),
    q = {
      branch: 0 as const,
      side: 0 as const,
      level: 0,
      price: BigInt(o.terms.price.toString()),
      quantity: 1000000n,
    };
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
test("ranked quote diff retains independent bid and ask ladder levels", () => {
  const ladder = {
    bid: [
      { branch: 0 as const, side: 0 as const, level: 0, price: 1_000_000n, quantity: 1_000_000n },
      { branch: 0 as const, side: 0 as const, level: 1, price: 900_000n, quantity: 1_000_000n },
      { branch: 0 as const, side: 0 as const, level: 2, price: 800_000n, quantity: 1_000_000n },
    ],
    ask: [
      { branch: 0 as const, side: 1 as const, level: 0, price: 1_100_000n, quantity: 1_000_000n },
      { branch: 0 as const, side: 1 as const, level: 1, price: 1_200_000n, quantity: 1_000_000n },
    ],
  };
  const desired = [...ladder.bid, ...ladder.ask];
  const resting = (price: bigint, side: number) => ({
    ...order(0, side),
    terms: { ...order(0, side).terms, price: bn(price) },
  });
  const current: [string, ReturnType<typeof order>][] = [
    ["outer-bid", resting(800_000n, 0)],
    ["best-bid", resting(1_000_000n, 0)],
    ["mid-bid", resting(900_000n, 0)],
    ["outer-ask", resting(1_200_000n, 1)],
    ["best-ask", resting(1_100_000n, 1)],
  ];
  expect(quoteChange(current, desired, 1n, config)).toBeUndefined();
  expect(quoteChange(current.slice(1), desired, 1n, config)).toEqual({ quote: ladder.bid[2]! });
  expect(quoteChange(current, desired.slice(0, 3), 1n, config)).toEqual({ cancel: "best-ask" });
  const changed = [...desired];
  changed[1] = { ...changed[1]!, price: 700_000n };
  expect(quoteChange(current, changed, 1n, config)).toEqual({
    cancel: "mid-bid",
    quote: changed[1],
  });
});
test("passive orders use own recipient, conditional funding, bounded expiry, no matching legs, and fresh salts", () => {
  const s = book(),
    q = {
      branch: 0 as const,
      side: 0 as const,
      level: 0,
      price: reference.spot,
      quantity: 1000000n,
    };
  const a = passiveOrder(owner, id, market, s, q, 120, 1000n),
    b = passiveOrder(owner, id, market, s, q, 120, 1000n);
  expect(a.recipient).toBe(a.maker);
  expect(a.fundingKind).toBe(1);
  expect(a.tif).toBe(0);
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
  });
  expect(plan.makers).toEqual([]);
  expect(plan.filledQuantity).toBe("0");
  expect(orderTerms(a).funding).toBe(1);
});
test("risk state halts on marked inventory drawdown, pauses jumps, and rejects time regression", () => {
  const s = book();
  s.wallets.set(walletAddress(key(id), owner, s.program).toBase58(), {
    balances: [0, 0, 100000000, 100000000, 100000000, 100000000].map(bn),
  } as WalletAccount);
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
  engine.plan(s, market, policy, { ...reference, observedAt: Date.now() });
  expect(BigInt(state.markets[id]!.peak!)).toBeGreaterThan(0n);
  expect(() =>
    engine.plan(s, market, policy, {
      ...reference,
      spot: reference.spot / 2n,
      observedAt: Date.now(),
    }),
  ).toThrow();
  expect(state.markets[id]!.halted).toBe(true);
  expect(() => engine.plan(s, market, policy, { ...reference, observedAt: Date.now() })).toThrow();
  const clean = initialState("test"),
    dry = new Engine({} as SolanaClient, owner, config, "https://example.com", clean, () => {});
  dry.plan(s, market, policy, { ...reference, observedAt: Date.now() });
  expect(() => dry.plan(s, market, policy, { ...reference, observedAt: 1 })).toThrow();
});

test("repeated execution reads do not decay volatility and churn the same quote within a cycle", () => {
  const state = initialState("test"),
    engine = new Engine({} as SolanaClient, owner, config, "https://example.com", state, () => {}),
    s = book();
  engine.plan(s, market, policy, { ...reference, observedAt: Date.now() });
  const moved = { ...reference, spot: (reference.spot * 101n) / 100n, observedAt: Date.now() };
  const first = engine.plan(s, market, policy, moved),
    vol = state.markets[id]!.movement;
  for (let i = 0; i < 5; i++) expect(engine.plan(s, market, policy, moved)).toEqual(first);
  expect(state.markets[id]!.movement).toBe(vol);
});

test("fee changes, nonce invalidation and foreign recipients cannot leave unusable/donating quotes", () => {
  const o = order(),
    q = {
      branch: 0 as const,
      side: 0 as const,
      level: 0,
      price: BigInt(o.terms.price.toString()),
      quantity: 1000000n,
    };
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
    deployment: { genesisHash: "test" },
    depositForCredit: async () => ({ gross: 100000000n, fee: 0n, instruction: {} }),
    wallet: async () => null,
    initializeWallet: () => ({}),
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
  await expect(engine.fund()).rejects.toThrow();
  expect(sends).toBe(1);
  await expect(engine.fund()).rejects.toThrow("Funding already attempted");
  expect(sends).toBe(1);
});
