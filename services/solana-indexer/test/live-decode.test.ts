import { describe, expect, test } from "bun:test";
import { PublicKey, bn, encodeAccount, traderAddress } from "@conditional-stocks/solana-client";
import { ProgramView, decodeProgramAccount } from "../src/live/decode.ts";
import { snapshot } from "../src/projection.ts";
import { liveFixture, orderFixture, programAccounts } from "./live-fixture.ts";

const known = { market: () => true, pool: () => true };
const unknown = { market: () => false, pool: () => false };

describe("program account decoding", () => {
  test("every projected kind decodes and authenticates its canonical address", () => {
    const f = liveFixture();
    const accounts = programAccounts(f.s, f.config);
    const kinds = new Map<string, string>();
    for (const [address, data] of accounts) {
      const decoded = decodeProgramAccount(f.client, address, data, known)!;
      kinds.set(decoded.kind, decoded.key);
    }
    expect([...kinds.keys()].sort()).toEqual(["config", "credit", "delegation", "market", "order", "pool", "trader", "wallet"]);
    // Traders are keyed by owner, everything else by address.
    expect(kinds.get("trader")).toBe(f.owner.toBase58());
    expect(kinds.get("delegation")).toBe(f.grantAddress);
  });

  test("accounts at a non-canonical address are integrity failures", () => {
    const f = liveFixture();
    const wrong = PublicKey.unique().toBase58();
    const cases: [string, Buffer][] = [
      ["asset pool", encodeAccount("AssetPool", [...f.s.pools.values()][0])],
      ["delegation", encodeAccount("TradingDelegate", f.grant)],
      ["trader", encodeAccount("Trader", f.trader)],
      ["market", encodeAccount("Market", [...f.s.markets.values()][0])],
      ["asset credit", encodeAccount("AssetCredit", [...f.s.credits.values()][0])],
      ["order", encodeAccount("Order", f.order)],
      ["wallet", encodeAccount("Wallet", [...f.s.wallets.values()][0])],
    ];
    for (const [name, data] of cases)
      expect(() => decodeProgramAccount(f.client, wrong, data, known)).toThrow(new RegExp(name, "i"));
  });

  test("other deployments, unknown parents and foreign data are ignored", () => {
    const f = liveFixture();
    const other = PublicKey.unique();
    const address = PublicKey.unique().toBase58();
    const foreign = [
      encodeAccount("AssetPool", { ...[...f.s.pools.values()][0]!, config: other }),
      encodeAccount("TradingDelegate", { ...f.grant, config: other }),
      encodeAccount("Trader", { ...f.trader, config: other }),
      encodeAccount("Market", { ...[...f.s.markets.values()][0]!, config: other }),
      encodeAccount("Config", f.s.config), // Another deployment's config account.
    ];
    for (const data of foreign) expect(decodeProgramAccount(f.client, address, data, known)).toBeNull();
    // Credits, orders and wallets need their pool/market projected first.
    for (const data of [
      encodeAccount("AssetCredit", [...f.s.credits.values()][0]),
      encodeAccount("Order", f.order),
      encodeAccount("Wallet", [...f.s.wallets.values()][0]),
    ])
      expect(decodeProgramAccount(f.client, address, data, unknown)).toBeNull();
    expect(decodeProgramAccount(f.client, address, Buffer.alloc(40), known)).toBeNull();
    expect(decodeProgramAccount(f.client, address, Buffer.alloc(0), known)).toBeNull();
  });
});

describe("incremental program view", () => {
  test("rebuild projects dependents regardless of account order", () => {
    const f = liveFixture();
    const view = new ProgramView(f.client);
    expect(view.ready).toBe(false);
    expect(() => view.snapshot).toThrow("not bootstrapped");
    const entries = [...programAccounts(f.s, f.config)].reverse();
    const s = view.rebuild(7, entries);
    expect(view.ready).toBe(true);
    expect(s.slot).toBe(7);
    expect(s.config.admin.equals(f.owner)).toBe(true);
    for (const kind of ["markets", "pools", "credits", "wallets", "orders", "traders", "delegations"] as const)
      expect([...s[kind]!.keys()].sort()).toEqual([...f.s[kind]!.keys()].sort());
    expect(view.kindOf(f.orderId)).toBe("order");
    expect(view.kindOf(f.config.toBase58())).toBe("config");
    expect(view.kindOf("unknown")).toBeUndefined();
    expect(() => view.rebuild(8, entries.filter(([a]) => a !== f.config.toBase58()))).toThrow("config is missing");
  });

  test("apply copies only changed kinds and handles updates, closes and new dependents", () => {
    const f = liveFixture();
    const view = new ProgramView(f.client);
    const before = view.rebuild(7, programAccounts(f.s, f.config));
    // Update an order, open a new one, close the delegation, pause the config.
    const updated = { ...f.order, remaining: bn(4) };
    const [newId, created] = orderFixture(f.marketId, f.other, f.s.program, { salt: 9 });
    const [creditId, credit] = [...f.s.credits][0]!;
    const { snapshot, changed } = view.apply(8, [
      [creditId, encodeAccount("AssetCredit", { ...credit, available: bn(1) })],
      [f.orderId, encodeAccount("Order", updated)],
      [newId, encodeAccount("Order", created)],
      [f.grantAddress, undefined],
      [f.config.toBase58(), encodeAccount("Config", { ...f.s.config, paused: true })],
      ["never-projected", undefined],
    ]);
    expect(changed).toEqual(new Set([creditId, f.orderId, newId, f.grantAddress, f.config.toBase58()]));
    expect(snapshot.credits.get(creditId)!.available.toString()).toBe("1");
    expect(snapshot.slot).toBe(8);
    expect(snapshot.orders.get(f.orderId)!.remaining.toString()).toBe("4");
    expect(snapshot.orders.has(newId)).toBe(true);
    expect(snapshot.delegations!.size).toBe(0);
    expect(snapshot.config.paused).toBe(true);
    // Copy-on-write: untouched kinds share the previous maps; the old snapshot is intact.
    expect(snapshot.markets).toBe(before.markets);
    expect(snapshot.orders).not.toBe(before.orders);
    expect(before.orders.get(f.orderId)!.remaining.toString()).toBe("10");
    expect(view.snapshot).toBe(snapshot);
    expect(view.kindOf(f.grantAddress)).toBeUndefined();
    // A market and its order arriving in the same slot resolve in dependency order.
    const g = liveFixture(1);
    const view2 = new ProgramView(g.client);
    const accounts = programAccounts(g.s, g.config);
    const [market] = [...g.s.markets.keys()];
    const withoutMarket = [...accounts].filter(([a]) => a !== market && !g.s.orders.has(a) && !g.s.wallets.has(a) && a !== g.grantAddress);
    const s0 = view2.rebuild(1, withoutMarket);
    expect(s0.orders.size).toBe(0);
    const s1 = view2.apply(2, [
      [g.orderId, accounts.get(g.orderId)!],
      [market!, accounts.get(market!)!],
    ]).snapshot;
    expect(s1.markets.has(market!)).toBe(true);
    expect(s1.orders.has(g.orderId)).toBe(true);
    // Trader closes remove the owner-keyed entry.
    const traderAccount = traderAddress(g.config, g.owner, g.s.program).toBase58();
    expect(view2.apply(3, [[traderAccount, undefined]]).snapshot.traders.size).toBe(0);
  });
});

test("one-shot RPC snapshots use the same decoder as the live index", async () => {
  const f = liveFixture(1);
  const accounts = programAccounts(f.s, f.config);
  let asserted = false;
  const client = {
    ...f.client,
    assertNetwork: async () => {
      asserted = true;
    },
    connection: {
      getProgramAccounts: async (_program: PublicKey, options: { commitment: string }) => ({
        context: { slot: options.commitment === "confirmed" ? 9 : 8 },
        value: [...accounts].map(([address, data]) => ({ pubkey: new PublicKey(address), account: { data } })),
      }),
    },
  };
  const s = await snapshot(client as never, "confirmed");
  expect(asserted).toBe(true);
  expect(s.slot).toBe(9);
  expect(s.orders.has(f.orderId)).toBe(true);
  expect(s.rawAccounts!.map((a) => a.address)).toEqual([...accounts.keys()].sort((a, b) => a.localeCompare(b)));
  expect((await snapshot(client as never)).slot).toBe(8);
});
