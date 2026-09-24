import { expect, test } from "bun:test";
import {
  PublicKey,
  bn,
  big,
  coder,
  encodeAccount,
  type OrderAccount,
} from "@conditional-stocks/solana-client";
import { decodeSnapshot, type Snapshot } from "../src/projection";
import { reconcileLedger, globalAvailable, reservedUnderlying } from "../src/custody";
import { payoutCredits } from "../src/payouts";
import { changedTopics } from "../src/stream";

import { custodyFixture } from "./custody-fixture";

test("shared underlying is counted once; sibling event markets retain separate claims", () => {
  const { s, owner, quote } = custodyFixture();
  expect(reconcileLedger(s)).toMatchObject({ pools: 2, credits: 2, markets: 2 });
  expect(globalAvailable(s, String(owner), String(quote))).toBe(200n);
  const rows = payoutCredits(s, String(owner));
  expect(rows.filter((p) => p.scope === "global" && p.asset === String(quote))).toHaveLength(1);
  expect(
    rows
      .filter((p) => p.scope === "market")
      .map((p) => [p.marketId, p.amount, p.tokenId, p.collateral, p.branch, p.kind]),
  ).toEqual([...s.markets.keys()].map((m, i) => [m, String(20 + i * 10), "4", 1, "YES", "stock"]));
  expect(payoutCredits(s, String(PublicKey.unique()))).toEqual([]);
});
test("ledger conservation rejects duplicated collateral, wrong claims and market-local cash", () => {
  for (const mutate of [
    (s: Snapshot) => {
      [...s.credits.values()][0]!.available = bn(101);
    },
    (s: Snapshot) => {
      [...s.markets.values()][0]!.backing[0] = bn(41);
    },
    (s: Snapshot) => {
      [...s.wallets.values()][0]!.balances[0] = bn(1);
    },
    (s: Snapshot) => {
      [...s.markets.values()][0]!.credits[1] = bn(1);
    },
    (s: Snapshot) => {
      [...s.wallets.values()][0]!.balances[2] = bn(21);
    },
    (s: Snapshot) => {
      [...s.wallets.values()][0]!.balances[3] = bn(1);
    },
    (s: Snapshot) => {
      [...s.markets.values()][0]!.backing[3] = bn(1);
    },
    (s: Snapshot) => {
      [...s.markets.values()][0]!.backing[2] = bn(41);
    },
    (s: Snapshot) => {
      [...s.markets.values()][0]!.escrow[6] = bn(1);
    },
    (s: Snapshot) => {
      [...s.wallets.values()][0]!.balances[11] = bn(1);
    },
    (s: Snapshot) => {
      [...s.markets.values()][0]!.credits.pop();
    },
    (s: Snapshot) => {
      s.pools.clear();
    },
  ]) {
    const { s } = custodyFixture(2);
    mutate(s);
    expect(() => reconcileLedger(s)).toThrow();
  }
});
test("expired reservations remain locked globally until on-chain cancellation", () => {
  const { s, owner, quote } = custodyFixture(),
    [id, m] = [...s.markets][0]!;
  const order = {
    owner,
    market: new PublicKey(id),
    delegate: PublicKey.default,
    status: 1,
    reserved: bn(10),
    remaining: bn(10),
    terms: {
      funding: 0,
      side: 0,
      branch: 0,
      recipient: owner,
      salt: Array(32).fill(1),
      quantity: bn(10),
      price: bn(10n ** 18n),
      nonce: bn(0),
      expiry: bn(1),
      max_fee_bps: 0,
      tif: 0,
      bases: 1,
    },
  } as OrderAccount;
  s.orders.set(String(PublicKey.unique()), order);
  m.escrow[0] = bn(10);
  [...s.credits.values()].find((c) => s.pools.get(String(c.pool))!.mint.equals(quote))!.available =
    bn(190);
  expect(reconcileLedger(s).pools).toBe(2);
  expect(reservedUnderlying(s, String(owner), String(quote))).toBe(10n);
  expect(globalAvailable(s, String(owner), String(quote))).toBe(190n);
});
test("pool-funded asks reserve raw units of their own issuer leg across three legs", () => {
  const { s, owner, bases, quote } = custodyFixture(3),
    [id, m] = [...s.markets][0]!;
  const ask = {
    owner,
    market: new PublicKey(id),
    delegate: PublicKey.default,
    status: 1,
    reserved: bn(7),
    remaining: bn(5),
    terms: {
      funding: 0,
      side: 1,
      branch: 1,
      recipient: owner,
      salt: Array(32).fill(2),
      quantity: bn(5),
      price: bn(10n ** 18n),
      nonce: bn(0),
      expiry: bn(9999999999),
      max_fee_bps: 0,
      tif: 0,
      bases: 0b010,
    },
  } as OrderAccount;
  s.orders.set(String(PublicKey.unique()), ask);
  expect(() => reconcileLedger(s)).toThrow("reservation ledger");
  m.escrow[6] = bn(7);
  expect(() => reconcileLedger(s)).toThrow("pool liability");
  [...s.credits.values()].find((c) => s.pools.get(String(c.pool))!.mint.equals(bases[1]!))!.available =
    bn(93);
  expect(reconcileLedger(s)).toMatchObject({ pools: 4, markets: 2 });
  expect(reservedUnderlying(s, String(owner), String(bases[1]))).toBe(7n);
  for (const mint of [bases[0]!, bases[2]!, quote])
    expect(reservedUnderlying(s, String(owner), String(mint))).toBe(0n);
  // Claim-funded asks reserve the leg's own claim in the market wallet.
  ask.terms.funding = 1;
  m.escrow[6] = bn(0);
  m.escrow[8] = bn(7);
  m.credits[8] = bn(0);
  expect(() => reconcileLedger(s)).toThrow();
  expect(reservedUnderlying(s, String(owner), String(bases[1]))).toBe(0n);
});
test("global credit changes notify their owner without invalidating unrelated market lists", () => {
  const { s, owner } = custodyFixture(),
    id = [...s.credits.keys()][0]!;
  const before = { ...s, rawAccounts: [{ address: id, data: "before" }] },
    after = { ...s, slot: 101, rawAccounts: [{ address: id, data: "after" }] };
  expect(changedTopics(before, after)).toMatchObject({ owners: [String(owner)], markets: [] });
});
test("snapshot decoding validates global PDAs and isolates deployments without RPC", async () => {
  const { s, config, owner, quote } = custodyFixture();
  const raw = [
    {
      address: String(config),
      data: (await coder.accounts.encode("Config", s.config)).toString("base64"),
    },
  ];
  for (const [kind, accounts] of [
    ["AssetPool", s.pools],
    ["AssetCredit", s.credits],
    ["Market", s.markets],
    ["Wallet", s.wallets],
  ] as const)
    for (const [address, data] of accounts)
      raw.push({ address, data: encodeAccount(kind, data).toString("base64") });
  const decoded = decodeSnapshot({ config, program: s.program }, 100, raw);
  expect(globalAvailable(decoded, String(owner), String(quote))).toBe(200n);
  expect([...decoded.wallets.values()].map((w) => w.balances.map(big))).toEqual(
    [20n, 30n].map((credit) => Array.from({ length: 12 }, (_, a) => (a === 4 ? credit : 0n))),
  );
  expect([...decoded.markets.values()].map((m) => [m.bases, m.legs[0]!.active])).toEqual([
    [1, true],
    [1, true],
  ]);
  expect(() =>
    decodeSnapshot(
      { config, program: s.program },
      100,
      raw.map((r, i) => (i === 1 ? { ...r, address: String(PublicKey.unique()) } : r)),
    ),
  ).toThrow("pool PDA");
});
