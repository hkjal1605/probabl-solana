import { describe, expect, test } from "bun:test";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  bn,
  digest,
  encodeAccount,
  legAccounts,
  marketAddress,
  poolAddress,
  poolVaultAddress,
} from "@conditional-stocks/solana-client";
import { LiveIndex, trackedAccounts, type CommitNotice } from "../src/live/index.ts";
import type { subscribeRequest } from "../src/live/geyser.ts";
import { marketFixture } from "./custody-fixture.ts";
import {
  fakeConnection,
  fakeGeyser,
  legInfos,
  liveFixture,
  orderFixture,
  programAccounts,
  until,
  updates,
  vaultInfo,
} from "./live-fixture.ts";

const CONFIRMED = 1,
  FINALIZED = 2,
  PROCESSED = 0,
  DEAD = 6;

function harness(options: { staleMs?: number } = {}) {
  const f = liveFixture(2);
  const accounts = programAccounts(f.s, f.config);
  const connection = fakeConnection({
    program: f.s.program,
    slot: 100,
    programAccounts: accounts,
    others: legInfos(f.bases, f.config, f.s.program),
  });
  const geyser = fakeGeyser();
  const notices: CommitNotice[] = [],
    errors: unknown[] = [],
    resyncs: number[] = [];
  const live = new LiveIndex({
    client: { ...f.client, connection } as never,
    geyser: geyser.factory,
    onCommit: (n) => notices.push(n),
    onResync: (slot) => resyncs.push(slot),
    onError: (e) => errors.push(e),
    source: { backoffMs: 1, maxBackoffMs: 4 },
    ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
  });
  const program = f.s.program;
  const stream = () => geyser.state.stream!;
  const programUpdate = (address: string, slot: number, data: Buffer, lamports = 1, writeVersion = 1) =>
    stream().push(updates.account(address, slot, program, data, writeVersion, lamports));
  const slot = (n: number, status: number, parent?: number) => stream().push(updates.slot(n, status, parent));
  const transaction = (n: number, signature: number) =>
    stream().push({
      transaction: {
        slot: String(n),
        transaction: {
          signature: new Uint8Array(64).fill(signature),
          transaction: { message: { accountKeys: [program.toBytes()], instructions: [] } },
          meta: { logMessages: [], logMessagesNone: false, loadedWritableAddresses: [], loadedReadonlyAddresses: [] },
        },
      },
    });
  return { f, accounts, connection, geyser, notices, errors, resyncs, live, stream, programUpdate, slot, transaction };
}

const withRemaining = (h: ReturnType<typeof harness>, remaining: number) =>
  encodeAccount("Order", { ...h.f.order, remaining: bn(remaining) });

describe("live chain index", () => {
  test("bootstraps from finalized RPC state and streams from the next slot", async () => {
    const h = harness();
    expect(() => h.live.confirmed()).toThrow("not bootstrapped");
    expect(() => h.live.finalized()).toThrow("not bootstrapped");
    // Events before bootstrap are ignored.
    h.live.handle({ kind: "slot", slot: 1, status: "confirmed" });
    await h.live.start();
    const [gpa, read] = h.connection.calls;
    expect(gpa!.args[1]).toEqual({ commitment: "finalized", withContext: true });
    expect(read!.args[1]).toEqual({ commitment: "finalized", minContextSlot: 100 });
    for (const commitment of ["confirmed", "finalized"] as const) {
      const s = h.live[commitment]();
      expect(s.slot).toBe(100);
      expect([...s.orders.keys()]).toEqual([h.f.orderId]);
      expect(s.markets.size).toBe(2);
      expect(Object.values(s.legs!.get(h.f.marketId)!).map((l) => l.tradable)).toEqual([true, true]);
    }
    const request = h.stream().writes[0] as ReturnType<typeof subscribeRequest>;
    expect(request.fromSlot).toBe("101");
    const tracked = [...trackedAccounts(h.f.s.markets.values(), h.f.client)].sort();
    expect(request.accounts.tracked!.account).toEqual(tracked);
    expect(tracked.length).toBe(4); // Two shared issuer mints + their pool vaults.
    const health = h.live.health();
    expect(health).toMatchObject({ healthy: true, connected: true, confirmedSlot: 100, finalizedSlot: 100 });
    expect(health.backlog).toEqual({ staged: 0, pending: 0 });
    const raw = h.live.rawAccounts("finalized");
    expect(raw.length).toBe(h.accounts.size);
    expect(raw.map((r) => r.address)).toEqual([...h.accounts.keys()].sort());
    expect(raw.find((r) => r.address === h.f.orderId)!.data).toBe(h.accounts.get(h.f.orderId)!.toString("base64"));
    expect(h.live.accountInfo("confirmed", h.f.bases[0]!.toBase58())!.owner.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(h.live.accountInfo("confirmed", PublicKey.unique().toBase58())).toBeNull();
    h.live.stop();
    expect(h.live.health()).toMatchObject({ healthy: false, connected: false });
  });

  test("slots commit to the confirmed view first and to the finalized view once final", async () => {
    const h = harness();
    await h.live.start();
    h.programUpdate(h.f.orderId, 101, withRemaining(h, 4));
    h.transaction(101, 1);
    h.stream().push(updates.blockTime(101, 1_700_000_101));
    expect(h.live.confirmed().orders.get(h.f.orderId)!.remaining.toString()).toBe("10");
    h.slot(101, CONFIRMED);
    const confirmed = h.notices[0]!;
    expect(confirmed.commitment).toBe("confirmed");
    expect(confirmed.slot).toBe(101);
    expect(confirmed.changed).toEqual(new Set([h.f.orderId]));
    expect(confirmed.previous.orders.get(h.f.orderId)!.remaining.toString()).toBe("10");
    expect(confirmed.transactions.map((t) => [t.slot, t.blockTime])).toEqual([[101, 1_700_000_101]]);
    // Unchanged issuer accounts: live leg state is reused, not recomputed.
    expect(confirmed.snapshot.legs).toBe(confirmed.previous.legs);
    expect(h.live.confirmed().orders.get(h.f.orderId)!.remaining.toString()).toBe("4");
    expect(h.live.finalized().orders.get(h.f.orderId)!.remaining.toString()).toBe("10");
    // Replayed duplicates after a reconnect are ignored.
    h.transaction(101, 1);
    h.programUpdate(h.f.orderId, 101, withRemaining(h, 4));
    h.slot(101, CONFIRMED);
    expect(h.notices.length).toBe(1);
    // A transaction whose block time arrives after confirmation gets it at finalization.
    h.transaction(102, 2);
    h.slot(102, CONFIRMED);
    expect(h.notices[1]!.transactions[0]!.blockTime).toBeNull();
    h.stream().push(updates.blockTime(102, 1_700_000_102));
    h.slot(102, FINALIZED);
    const finalized = h.notices.at(-1)!;
    expect(finalized.commitment).toBe("finalized");
    expect(finalized.changed).toEqual(new Set([h.f.orderId]));
    expect(finalized.transactions.map((t) => [t.slot, t.blockTime])).toEqual([
      [101, 1_700_000_101],
      [102, 1_700_000_102],
    ]);
    expect(h.live.finalized().orders.get(h.f.orderId)!.remaining.toString()).toBe("4");
    // Events at or below the finalized slot are stale.
    h.transaction(102, 3);
    h.stream().push(updates.blockTime(102, 1));
    h.slot(103, CONFIRMED);
    expect(h.notices.length).toBe(3);
    // Quiet slots advance the view without notifying.
    expect(h.live.confirmed().slot).toBe(103);
    expect(h.live.health().confirmedSlot).toBe(103);
    h.live.stop();
  });

  test("closed accounts leave the projection", async () => {
    const h = harness();
    await h.live.start();
    h.programUpdate(h.f.orderId, 101, Buffer.alloc(0), 0);
    h.slot(101, CONFIRMED);
    expect(h.live.confirmed().orders.size).toBe(0);
    expect(h.notices[0]!.changed).toEqual(new Set([h.f.orderId]));
    h.live.stop();
  });

  test("issuer mint and vault changes recompute live leg state", async () => {
    const h = harness();
    await h.live.start();
    const [mint] = h.f.bases;
    const pool = poolAddress(h.f.config, mint!, h.f.s.program);
    const vault = poolVaultAddress(pool, h.f.s.program).toBase58();
    h.stream().push(updates.account(vault, 101, TOKEN_PROGRAM_ID, vaultInfo(mint!, pool, true).data));
    h.slot(101, CONFIRMED);
    const notice = h.notices[0]!;
    expect(notice.changed).toEqual(new Set([vault]));
    expect(notice.snapshot.legs).not.toBe(notice.previous.legs);
    expect(notice.snapshot.legs!.get(h.f.marketId)![1]!.halt).toBe("vault-frozen");
    expect(h.live.finalized().legs!.get(h.f.marketId)![1]!.halt).toBeNull();
    // Time-based re-evaluation keeps the same inputs but produces fresh state.
    const before = h.live.confirmed().legs;
    h.live.refreshLegs();
    expect(h.live.confirmed().legs).not.toBe(before);
    expect(h.live.confirmed().legs!.get(h.f.marketId)![1]!.halt).toBe("vault-frozen");
    h.live.stop();
  });

  test("a new market with a new issuer leg is tracked and seeded", async () => {
    const h = harness();
    await h.live.start();
    const mint = PublicKey.unique();
    const id = digest("new-market");
    const address = marketAddress(h.f.config, id, h.f.s.program);
    const market = marketFixture({
      config: h.f.config,
      market: address,
      program: h.f.s.program,
      quote: h.f.quote,
      bases: [mint],
      id,
    });
    for (const [k, v] of legInfos([mint], h.f.config, h.f.s.program)) h.connection.others.set(k, v);
    const writes = h.stream().writes.length;
    h.programUpdate(address.toBase58(), 101, encodeAccount("Market", market));
    h.slot(101, CONFIRMED);
    expect(h.live.confirmed().markets.has(address.toBase58())).toBe(true);
    // The subscription now includes the new mint and vault.
    const request = h.stream().writes.at(-1) as ReturnType<typeof subscribeRequest>;
    expect(h.stream().writes.length).toBe(writes + 1);
    const added = legAccounts(market, h.f.config, h.f.s.program).map(String);
    for (const a of added) expect(request.accounts.tracked!.account).toContain(a);
    // Seeded from confirmed RPC state, then legs become tradable.
    await until(() => h.live.confirmed().legs!.get(address.toBase58())![1]!.tradable);
    const seed = h.connection.calls.at(-1)!;
    expect(seed.args[1]).toEqual({ commitment: "confirmed" });
    expect((seed.args[0] as PublicKey[]).map(String).sort()).toEqual(added.sort());
    // A market update that adds no accounts does not re-read anything.
    const calls = h.connection.calls.length;
    h.programUpdate(address.toBase58(), 102, encodeAccount("Market", { ...market, state: 3 }));
    h.slot(102, CONFIRMED);
    await Bun.sleep(5);
    expect(h.connection.calls.length).toBe(calls);
    // A failed seed read is reported, not thrown.
    const second = PublicKey.unique();
    const id2 = digest("another-market");
    const address2 = marketAddress(h.f.config, id2, h.f.s.program);
    h.connection.short = true;
    h.programUpdate(
      address2.toBase58(),
      103,
      encodeAccount("Market", marketFixture({ config: h.f.config, market: address2, program: h.f.s.program, quote: h.f.quote, bases: [second], id: id2 })),
    );
    h.slot(103, CONFIRMED);
    await until(() => h.errors.length > 0);
    expect(String(h.errors[0])).toContain("Incomplete account read");
    h.live.stop();
  });

  test("abandoned forks and dead slots are rolled back from the confirmed view", async () => {
    const h = harness();
    await h.live.start();
    h.slot(101, PROCESSED, 100);
    h.slot(102, PROCESSED, 100);
    h.programUpdate(h.f.orderId, 101, withRemaining(h, 1));
    h.transaction(101, 9);
    h.slot(101, CONFIRMED);
    expect(h.live.confirmed().orders.get(h.f.orderId)!.remaining.toString()).toBe("1");
    h.programUpdate(h.f.orderId, 102, withRemaining(h, 2));
    h.slot(102, CONFIRMED);
    h.slot(102, FINALIZED);
    const [rebuilt, finalized] = h.notices.slice(-2);
    // Slot 101 is on an abandoned fork: the confirmed view is rebuilt from the
    // finalized chain (100 -> 102) and its transaction is never finalized.
    expect(rebuilt!.commitment).toBe("confirmed");
    expect(rebuilt!.rebuilt).toBe(true);
    expect(finalized!.commitment).toBe("finalized");
    expect(finalized!.transactions).toEqual([]);
    expect(h.live.confirmed().orders.get(h.f.orderId)!.remaining.toString()).toBe("2");
    expect(h.live.finalized().orders.get(h.f.orderId)!.remaining.toString()).toBe("2");
    // Dead slot: its confirmed updates and transactions disappear.
    h.programUpdate(h.f.orderId, 103, withRemaining(h, 3));
    h.transaction(103, 10);
    h.slot(103, CONFIRMED);
    h.slot(104, CONFIRMED);
    expect(h.live.confirmed().orders.get(h.f.orderId)!.remaining.toString()).toBe("3");
    h.slot(103, DEAD);
    const dead = h.notices.at(-1)!;
    expect(dead.rebuilt).toBe(true);
    expect(dead.changed).toEqual(new Set([h.f.orderId]));
    expect(h.live.confirmed().orders.get(h.f.orderId)!.remaining.toString()).toBe("2");
    // A dead slot that never committed changes nothing.
    const count = h.notices.length;
    h.slot(105, DEAD);
    expect(h.notices.length).toBe(count);
    h.slot(104, FINALIZED);
    expect(h.notices.at(-1)!.transactions).toEqual([]);
    h.live.stop();
  });

  test("a replay gap re-bootstraps from RPC and resumes the stream", async () => {
    const h = harness();
    await h.live.start();
    h.geyser.state.firstAvailable = "5000";
    h.connection.slot = 6000;
    h.connection.failProgramAccounts = 1;
    h.stream().emit("error", new Error("reset"));
    await until(() => h.resyncs.length === 1, 5000);
    expect(h.resyncs).toEqual([6000]);
    expect(h.errors.map(String)).toEqual([
      "Error: reset",
      "Error: Geyser cannot replay from slot 101 (first available 5000)",
      "Error: rpc unavailable",
    ]);
    await until(() => h.live.health().healthy);
    expect((h.stream().writes[0] as ReturnType<typeof subscribeRequest>).fromSlot).toBe("6001");
    expect(h.live.finalized().slot).toBe(6000);
    h.live.stop();
  });

  test("a commit that fails authentication makes the index re-bootstrap", async () => {
    const h = harness();
    await h.live.start();
    // An order image at a non-canonical address.
    const [, order] = orderFixture(h.f.marketId, h.f.owner, h.f.s.program, { salt: 3 });
    h.programUpdate(PublicKey.unique().toBase58(), 101, encodeAccount("Order", order));
    h.slot(101, CONFIRMED);
    expect(h.live.health().healthy).toBe(false);
    h.live.handle({ kind: "slot", slot: 102, status: "confirmed" }); // Ignored while resyncing.
    await until(() => h.resyncs.length === 1);
    expect(String(h.errors[0])).toContain("Invalid order PDA");
    await until(() => h.live.health().healthy);
    h.live.stop();
  });

  test("a silent stream is unhealthy; an incomplete bootstrap read fails start", async () => {
    const h = harness({ staleMs: 5 });
    await h.live.start();
    await Bun.sleep(20);
    expect(h.live.health().healthy).toBe(false);
    h.stream().push(updates.slot(101, PROCESSED, 100));
    expect(h.live.health().healthy).toBe(true);
    h.live.stop();
    const g = harness();
    g.connection.short = true;
    await expect(g.live.start()).rejects.toThrow("Incomplete account read");
  });
});


test("a failing commit consumer is reported without disturbing the index", async () => {
  const f = liveFixture(1);
  const connection = fakeConnection({
    program: f.s.program,
    slot: 100,
    programAccounts: programAccounts(f.s, f.config),
    others: legInfos(f.bases, f.config, f.s.program),
  });
  const geyser = fakeGeyser();
  const errors: unknown[] = [];
  const live = new LiveIndex({
    client: { ...f.client, connection } as never,
    geyser: geyser.factory,
    onCommit: () => {
      throw new Error("consumer failed");
    },
    onError: (e) => errors.push(e),
  });
  await live.start();
  geyser.state.stream!.push(
    updates.account(f.orderId, 101, f.s.program, encodeAccount("Order", { ...f.order, remaining: bn(3) })),
  );
  geyser.state.stream!.push(updates.slot(101, CONFIRMED));
  expect(String(errors[0])).toContain("consumer failed");
  expect(live.health().healthy).toBe(true);
  expect(live.confirmed().orders.get(f.orderId)!.remaining.toString()).toBe("3");
  live.stop();
});

test("reconnects replay only slots after the confirmed one; every handled event reaches the relay tap", async () => {
  const f = liveFixture(1);
  const connection = fakeConnection({
    program: f.s.program,
    slot: 100,
    programAccounts: programAccounts(f.s, f.config),
    others: legInfos(f.bases, f.config, f.s.program),
  });
  const geyser = fakeGeyser();
  const tapped: string[] = [];
  const live = new LiveIndex({
    client: { ...f.client, connection } as never,
    geyser: geyser.factory,
    source: { backoffMs: 1, maxBackoffMs: 4 },
    onEvent: (event) => tapped.push(event.kind === "slot" ? `slot:${event.slot}:${event.status}` : event.kind),
  });
  live.handle({ kind: "slot", slot: 1, status: "confirmed" }); // Not bootstrapped: not relayed.
  await live.start();
  const stream = geyser.state.stream!;
  stream.push(updates.account(f.orderId, 101, f.s.program, encodeAccount("Order", { ...f.order, remaining: bn(2) })));
  stream.push(updates.slot(101, CONFIRMED));
  stream.push(updates.slot(102, CONFIRMED));
  expect(tapped).toEqual(["account", "slot:101:confirmed", "slot:102:confirmed"]);
  expect(live.health().finalizedSlot).toBe(100);
  stream.emit("error", new Error("reset"));
  await until(() => geyser.state.streams.length === 2 && live.health().connected);
  // Not from finalized + 1 (101): slots up to 102 are already committed here.
  expect((geyser.state.stream!.writes[0] as ReturnType<typeof subscribeRequest>).fromSlot).toBe("103");
  live.stop();
});
