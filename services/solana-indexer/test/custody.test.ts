import { expect, test } from "bun:test";
import { PublicKey, bn, big, coder, type OrderAccount } from "@conditional-stocks/solana-client";
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
  expect(rows.filter((p) => p.scope === "market").map((p) => [p.marketId, p.amount])).toEqual(
    [...s.markets.keys()].map((m, i) => [m, String(20 + i * 10)]),
  );
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
      s.pools.clear();
    },
  ]) {
    const { s } = custodyFixture();
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
    },
  } as OrderAccount;
  s.orders.set(String(PublicKey.unique()), order);
  m.escrow[1] = bn(10);
  [...s.credits.values()].find((c) => s.pools.get(String(c.pool))!.mint.equals(quote))!.available =
    bn(190);
  expect(reconcileLedger(s).pools).toBe(2);
  expect(reservedUnderlying(s, String(owner), String(quote))).toBe(10n);
  expect(globalAvailable(s, String(owner), String(quote))).toBe(190n);
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
      raw.push({ address, data: (await coder.accounts.encode(kind, data)).toString("base64") });
  const decoded = decodeSnapshot({ config, program: s.program }, 100, raw);
  expect(globalAvailable(decoded, String(owner), String(quote))).toBe(200n);
  expect([...decoded.wallets.values()].map((w) => w.balances.slice(0, 2).map(big))).toEqual([
    [0n, 0n],
    [0n, 0n],
  ]);
  expect(() =>
    decodeSnapshot(
      { config, program: s.program },
      100,
      raw.map((r, i) => (i === 1 ? { ...r, address: String(PublicKey.unique()) } : r)),
    ),
  ).toThrow("pool PDA");
});
