import { expect, test } from "bun:test";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  LOOKUP_TABLE_CAPACITY,
  bn,
  deploymentLookupAddresses,
  delegationAddress,
  marketLookupAddresses,
  orderId,
  orderWire,
  participantLookupAddresses,
  traderAddress,
  walletAddress,
  type OrderAccount,
} from "@conditional-stocks/solana-client";
import { desiredLookupAddresses, LookupKeeper, parseRegisteredOwners } from "../src/lookup-keeper";
import { custodyFixture } from "./custody-fixture";

function withLiveOrder(f: ReturnType<typeof custodyFixture>, owner: PublicKey, delegate = PublicKey.default, status = 1) {
  const [market, account] = [...f.s.markets][0]!;
  const program = f.s.program;
  f.s.wallets.set(String(walletAddress(new PublicKey(market), owner, program)), {
    market: new PublicKey(market), owner, balances: account.credits.map(() => bn(0)), open_notional: bn(0), bump: 0,
  });
  f.s.traders.set(String(owner), { config: f.config, owner, minimum_nonce: bn(0), delegation_epoch: bn(0), bump: 0 });
  if (!delegate.equals(PublicKey.default))
    f.s.delegations!.set(String(delegationAddress(f.config, owner, delegate, program)), {
      config: f.config, owner, delegate, market: PublicKey.default, epoch: bn(0), expires_at: bn(9_999_999_999),
      max_order_quote: bn(1_000), remaining_quote: bn(1_000), max_fee_bps: 1000, permissions: 3, revoked: false, bump: 0,
    });
  const o = {
    market: new PublicKey(market), owner, delegate, remaining: bn(10), filled: bn(0), reserved: bn(10), open_notional: bn(1),
    sequence: bn(f.s.orders.size), fee_carry: 0, status, bump: 0,
    terms: { recipient: owner, salt: Array(32).fill(f.s.orders.size + 1), quantity: bn(10), price: bn(10n ** 17n),
      expiry: bn(9_999_999_999), nonce: bn(0), max_fee_bps: 1000, branch: 0, side: 1, funding: 1, tif: 0, bases: 1 },
  } as OrderAccount;
  f.s.orders.set(orderId(orderWire(o), program), o);
  return { market: new PublicKey(market), account };
}

test("desired addresses: program accounts, every market's static accounts, then only live-order participants", () => {
  const f = custodyFixture(2);
  f.s.traders.set(String(f.owner), { config: f.config, owner: f.owner, minimum_nonce: bn(0), delegation_epoch: bn(0), bump: 0 });
  const maker = PublicKey.unique(), delegate = PublicKey.unique(), cancelled = PublicKey.unique();
  const { market, account } = withLiveOrder(f, maker, delegate);
  withLiveOrder(f, cancelled, PublicKey.default, 3);
  const client = { config: f.config, program: f.s.program };
  const desired = desiredLookupAddresses(f.s, client).map(String);
  const expectedStart = [
    ...deploymentLookupAddresses(f.config, f.s.program),
    ...[...f.s.markets]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([id, m]) => marketLookupAddresses(f.config, new PublicKey(id), m, f.s.program)),
  ].map(String);
  expect(desired.slice(0, expectedStart.length)).toEqual(expectedStart);
  expect(desired.slice(expectedStart.length)).toEqual(
    participantLookupAddresses(f.config, market, account, maker, [delegate], f.s.program).map(String),
  );
  // Wallets without live orders (spam-resistant) and cancelled orders add nothing.
  expect(desired).not.toContain(String(traderAddress(f.config, cancelled, f.s.program)));
  expect(desired).not.toContain(String(traderAddress(f.config, f.owner, f.s.program)));
});

/** In-memory chain for lookup-table instructions sent by the keeper. */
function chain(authority: Keypair) {
  const tables = new Map<string, { addresses: PublicKey[]; authority: PublicKey; deactivation: bigint }>();
  const registry = new Map<string, { authority: string; slot: number }>();
  let sent = 0;
  const encode = (t: { addresses: PublicKey[]; authority: PublicKey; deactivation: bigint }) => {
    const data = Buffer.alloc(56 + 32 * t.addresses.length);
    data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE(t.deactivation, 4);
    data.writeUInt8(1, 21);
    t.authority.toBuffer().copy(data, 22);
    t.addresses.forEach((a, i) => a.toBuffer().copy(data, 56 + 32 * i));
    return data;
  };
  let reads = 0;
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      (reads++, keys).map((k) => {
        const t = tables.get(String(k));
        return t ? { data: encode(t), owner: AddressLookupTableProgram.programId, lamports: 1, executable: false } : null;
      }),
    getSlot: async () => 1_000 + sent, // advances like a real chain: table addresses derive from it
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 }),
    confirmTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction: async (raw: Buffer) => {
      sent++;
      const tx = VersionedTransaction.deserialize(raw);
      const ix = tx.message.compiledInstructions[0]!;
      const keys = ix.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i]!);
      const kind = Buffer.from(ix.data).readUInt32LE(0);
      if (kind === 0) {
        // The runtime rejects creating an existing table (same authority + slot).
        if (tables.has(String(keys[0]))) throw new Error("account already in use");
        tables.set(String(keys[0]), { addresses: [], authority: authority.publicKey, deactivation: (1n << 64n) - 1n });
      }
      else if (kind === 2) {
        const data = Buffer.from(ix.data), count = Number(data.readBigUInt64LE(4));
        const added = Array.from({ length: count }, (_, i) => new PublicKey(data.subarray(12 + 32 * i, 44 + 32 * i)));
        tables.get(String(keys[0]))!.addresses.push(...added);
      }
      return "sig" + sent;
    },
  };
  const store = {
    lookupTables: async () => [...registry.keys()],
    putLookupTable: async (_: string, address: string, owner: string, slot: number) => {
      registry.set(address, { authority: owner, slot });
    },
  };
  return { tables, registry, connection, store, sent: () => sent, reads: () => reads };
}

test("keeper creates, registers and extends append-only tables until every desired address is present", async () => {
  const f = custodyFixture(3);
  for (let i = 0; i < 70; i++) withLiveOrder(f, PublicKey.unique());
  const authority = Keypair.generate();
  const c = chain(authority);
  const client = { config: f.config, program: f.s.program };
  const keeper = new LookupKeeper(c.connection as never, client, c.store, "domain", authority, { maxTransactionsPerSync: 100 });
  const desired = desiredLookupAddresses(f.s, client);
  expect(desired.length).toBeGreaterThan(LOOKUP_TABLE_CAPACITY);
  for (let pass = 0; pass < 6; pass++) await keeper.sync(f.s);
  const kept = [...c.tables.values()].flatMap((t) => t.addresses.map(String));
  expect(new Set(kept)).toEqual(new Set(desired.map(String)));
  expect(kept).toHaveLength(new Set(desired.map(String)).size); // never appended twice
  expect([...c.tables.values()].every((t) => t.addresses.length <= LOOKUP_TABLE_CAPACITY)).toBe(true);
  expect(new Set(c.registry.keys())).toEqual(new Set(c.tables.keys()));
  // Converged: a further pass sends nothing, and once the cached table
  // contents cover every desired address it does no RPC at all.
  const before = c.sent();
  expect(await keeper.sync(f.s)).toEqual({ extended: 0, created: 0, skipped: false });
  expect(c.sent()).toBe(before);
  const reads = c.reads();
  for (let pass = 0; pass < 5; pass++) await keeper.sync(f.s);
  expect(c.reads()).toBe(reads);
  // New resting maker: only its PDAs are appended.
  const late = PublicKey.unique();
  const { market, account } = withLiveOrder(f, late);
  const result = await keeper.sync(f.s);
  expect(result.extended).toBe(participantLookupAddresses(f.config, market, account, late, [], f.s.program).length);
});

test("keeper respects its per-pass transaction cap and daily address budget, and ignores foreign tables", async () => {
  const f = custodyFixture(1);
  for (let i = 0; i < 20; i++) withLiveOrder(f, PublicKey.unique());
  const authority = Keypair.generate();
  const c = chain(authority);
  const client = { config: f.config, program: f.s.program };
  const capped = new LookupKeeper(c.connection as never, client, c.store, "domain", authority, { maxTransactionsPerSync: 2 });
  const first = await capped.sync(f.s);
  expect(first.created).toBe(1);
  expect(c.sent()).toBe(2); // create + one extend
  const budgeted = new LookupKeeper(c.connection as never, client, c.store, "domain", authority, { dailyAddressBudget: 25 });
  await budgeted.sync(f.s);
  await budgeted.sync(f.s);
  const added = [...c.tables.values()].reduce((n, t) => n + t.addresses.length, 0);
  expect(added).toBeLessThanOrEqual(20 + 25);
  // A registered table owned by another authority is never extended.
  const foreign = Keypair.generate();
  c.tables.set("F".repeat(43), { addresses: [], authority: foreign.publicKey, deactivation: (1n << 64n) - 1n });
  const other = new LookupKeeper(c.connection as never, client, c.store, "domain", foreign, { maxTransactionsPerSync: 1 });
  expect((await other.tables()).length).toBe(0);
  void AddressLookupTableAccount;
});

test("pre-registered market makers are table-resident in every market before their first quote", async () => {
  const f = custodyFixture(2);
  const mm = PublicKey.unique(),
    quoter = PublicKey.unique();
  const client = { config: f.config, program: f.s.program };
  const markets = [...f.s.markets].sort(([a], [b]) => a.localeCompare(b));
  const statics = [
    ...deploymentLookupAddresses(f.config, f.s.program),
    ...markets.flatMap(([id, m]) => marketLookupAddresses(f.config, new PublicKey(id), m, f.s.program)),
  ].map(String);
  const registered = markets.flatMap(([id, m]) =>
    participantLookupAddresses(f.config, new PublicKey(id), m, mm, [quoter], f.s.program).map(String),
  );
  expect(registered).toContain(String(delegationAddress(f.config, mm, quoter, f.s.program)));
  // Registered owners come right after the statics, ahead of live-order participants.
  const maker = PublicKey.unique();
  withLiveOrder(f, maker);
  const desired = desiredLookupAddresses(f.s, client, undefined, [{ owner: mm, delegates: [quoter] }]).map(String);
  expect(desired.slice(0, statics.length)).toEqual(statics);
  expect(desired.slice(statics.length, statics.length + registered.length)).toEqual(registered);
  expect(desired.slice(statics.length + registered.length).length).toBeGreaterThan(0);
  // The keeper appends them with no resting order at all.
  const authority = Keypair.generate();
  const c = chain(authority);
  const empty = custodyFixture(2);
  empty.s.markets = f.s.markets;
  const keeper = new LookupKeeper(c.connection as never, client, c.store, "domain", authority, {
    maxTransactionsPerSync: 100,
    owners: `${mm.toBase58()}:${quoter.toBase58()}`,
  });
  for (let pass = 0; pass < 3; pass++) await keeper.sync(empty.s);
  const kept = new Set([...c.tables.values()].flatMap((t) => t.addresses.map(String)));
  for (const address of registered) expect(kept.has(address)).toBe(true);
  expect(() => new LookupKeeper(c.connection as never, client, c.store, "domain", authority, { owners: "not-a-key" })).toThrow();
  // Configuration parsing: commas or whitespace, delegates after colons.
  const other = PublicKey.unique();
  expect(parseRegisteredOwners(` ${mm.toBase58()}:${quoter.toBase58()},\n${other.toBase58()} `)).toEqual([
    { owner: mm, delegates: [quoter] },
    { owner: other, delegates: [] },
  ]);
  expect(parseRegisteredOwners(undefined)).toEqual([]);
  expect(parseRegisteredOwners("")).toEqual([]);
  expect(() => parseRegisteredOwners(`${mm.toBase58()} ${mm.toBase58()}:${quoter.toBase58()}`)).toThrow("Duplicate");
});

test("the cached table view expires and is re-read", async () => {
  const f = custodyFixture(1);
  withLiveOrder(f, PublicKey.unique());
  const authority = Keypair.generate();
  const c = chain(authority);
  const client = { config: f.config, program: f.s.program };
  const keeper = new LookupKeeper(c.connection as never, client, c.store, "domain", authority, { maxTransactionsPerSync: 100, refreshMs: 0 });
  for (let pass = 0; pass < 3; pass++) await keeper.sync(f.s);
  const reads = c.reads();
  await keeper.sync(f.s);
  expect(c.reads()).toBe(reads + 1);
  // A concurrent pass is skipped outright.
  const [first, second] = await Promise.all([keeper.sync(f.s), keeper.sync(f.s)]);
  expect([first.skipped, second.skipped]).toEqual([false, true]);
});
