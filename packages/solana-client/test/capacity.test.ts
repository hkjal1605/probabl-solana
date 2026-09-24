import { expect, test } from "bun:test";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
} from "@solana/web3.js";
import {
  LOOKUP_EXTEND_CHUNK,
  LOOKUP_TABLE_CAPACITY,
  MAX_MAKERS,
  SIZING_BLOCKHASH,
  SolanaClient,
  UNIT_MULTIPLIER,
  WAD,
  budgetedInstructions,
  compileTransactionMessage,
  computeUnits,
  deploymentLookupAddresses,
  marketLookupAddresses,
  orderId,
  orderSalt,
  participantLookupAddresses,
  planLookupExtensions,
  parseAtomicPlan,
  planOrder,
  type OrderWire,
} from "../src/index";
import { marketAccount } from "./market-fixture";

const table = (addresses: PublicKey[], deactivationSlot = (1n << 64n) - 1n) =>
  new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses },
  });

/** A taker crossing `makers` distinct makers (one resting order each). */
function crossing(makers: number, legs: number, side: 0 | 1, funding: 0 | 1, tif: 0 | 1 = 0) {
  const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:1", genesisHash: "x", config: Keypair.generate().publicKey.toBase58() });
  const market = Keypair.generate().publicKey;
  const m = marketAccount({ config: client.config, market, program: client.program, legs });
  client.rememberMarket(market, m);
  const taker = Keypair.generate().publicKey.toBase58();
  const order: OrderWire = {
    maker: taker, recipient: taker, marketId: market.toBase58(), salt: orderSalt(1n, crypto.getRandomValues(new Uint8Array(32))),
    quantity: String(100 * makers), limitPriceRawX18: String((side === 0 ? 2n : 1n) * WAD), expiry: "99999", nonce: "1",
    maxFeeBps: 1000, branch: 0, side, fundingKind: funding, tif, bases: side === 0 ? (1 << legs) - 1 : 1,
  };
  const resting = Array.from({ length: makers }, (_, i) => {
    const maker = Keypair.generate().publicKey.toBase58();
    return {
      ...order, maker, recipient: maker, side: 1 - side, quantity: "100", tif: 0,
      limitPriceRawX18: String((side === 0 ? 1n : 2n) * WAD), salt: orderSalt(1n, crypto.getRandomValues(new Uint8Array(32))),
      bases: side === 0 ? 1 << (i % legs) : (1 << legs) - 1,
    };
  });
  const legState = Object.fromEntries(Array.from({ length: legs }, (_, i) => [i + 1, { scale: 1n, multiplier: UNIT_MULTIPLIER, tradable: true }]));
  const candidates = resting.map((o, i) => ({ order: o, orderHash: orderId(o), remaining: 100n, reserved: 100n, sequence: BigInt(i) }));
  const plan = (maxMakers = MAX_MAKERS) =>
    planOrder({ order, candidates, now: 1n, step: 1n, nextSequence: BigInt(makers), makerFeeBps: 0, takerFeeBps: 0, legs: legState, maxMakers });
  const deployment = table([...deploymentLookupAddresses(client.config, client.program), ...marketLookupAddresses(client.config, market, m, client.program)]);
  const participants = table(resting.flatMap((o) => participantLookupAddresses(client.config, market, m, new PublicKey(o.maker), [], client.program)));
  const placement = (maxMakers?: number) => client.placement(order, plan(maxMakers));
  const compile = (tables: AddressLookupTableAccount[]) =>
    compileTransactionMessage(new PublicKey(taker), budgetedInstructions([placement()], client.program), SIZING_BLOCKHASH, tables);
  const fits = (tables: AddressLookupTableAccount[], maxMakers?: number) => {
    const ix = client.placement(order, plan(maxMakers));
    try {
      compileTransactionMessage(new PublicKey(taker), budgetedInstructions([ix], client.program), SIZING_BLOCKHASH, tables);
      return true;
    } catch {
      return false;
    }
  };
  return { client, order, plan, fits, placement, compile, deployment, participants };
}

const capacity = (fits: (n: number) => boolean) => {
  let max = 0;
  for (let n = 1; n <= MAX_MAKERS; n++) if (fits(n)) max = n;
  return max;
};

test("diagnosis: one placement carries 1 maker bare, 5 with static tables, all 8 with keeper participant tables", () => {
  for (const legs of [1, 3])
    for (const [side, funding] of [[0, 0], [1, 0], [0, 1]] as const) {
      const bare = capacity((n) => crossing(n, legs, side, funding).fits([]));
      const deployment = capacity((n) => {
        const c = crossing(n, legs, side, funding);
        return c.fits([c.deployment]);
      });
      const kept = capacity((n) => {
        const c = crossing(n, legs, side, funding);
        return c.fits([c.deployment, c.participants]);
      });
      expect(bare).toBe(1);
      expect(deployment).toBeGreaterThanOrEqual(5);
      expect(deployment).toBeLessThan(MAX_MAKERS);
      expect(kept).toBe(MAX_MAKERS);
    }
  // The protocol maximum stays within the compute budget and the 64-account lock limit.
  for (const legs of [1, 3]) {
    const c = crossing(MAX_MAKERS, legs, 0, 0);
    const message = c.compile([c.deployment, c.participants]);
    expect(message.staticAccountKeys.length + message.numAccountKeysFromLookups).toBeLessThanOrEqual(64);
    expect(computeUnits([c.placement()], c.client.program)).toBeLessThanOrEqual(1_400_000);
  }
});

test("immediate-or-cancel fills as many makers as one transaction carries; resting orders are rejected instead", () => {
  const ioc = crossing(8, 1, 0, 0, 1);
  const partial = ioc.plan(5);
  expect(partial.makers).toHaveLength(5);
  expect(partial.filledQuantity).toBe("500");
  expect(partial.remainingQuantity).toBe("300");
  // On chain, makers gone since planning are skipped: an IOC must still fill
  // at least one step, a resting order may rest entirely.
  expect(partial.minFill).toBe("1");
  expect(parseAtomicPlan(partial, ioc.order)).toBe(partial);
  expect(() => parseAtomicPlan({ ...partial, minFill: "501" }, ioc.order)).toThrow("Plan totals");
  expect(() => parseAtomicPlan({ ...partial, minFill: "-1" }, ioc.order)).toThrow();
  const { minFill: _, ...legacy } = partial;
  expect(parseAtomicPlan(legacy, ioc.order)).toBe(legacy);
  const gtc = crossing(8, 1, 0, 0, 0);
  expect(() => gtc.plan(5)).toThrow("crosses more than 5 makers");
  expect(gtc.plan(8).makers).toHaveLength(8);
  expect(gtc.plan(8).minFill).toBe("0");
});

test("lookup extension plans append only missing addresses, fill tables with room, chunk extends and open new tables", () => {
  const addresses = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);
  const existing = addresses(250);
  const kept = [{ key: Keypair.generate().publicKey, addresses: existing, active: true }];
  const fresh = addresses(300);
  const plan = planLookupExtensions(kept, [...existing.slice(0, 10), ...fresh, ...fresh.slice(0, 5)]);
  expect(plan.missing.map(String)).toEqual(fresh.map(String));
  expect(plan.extend).toEqual([{ table: kept[0]!.key, addresses: fresh.slice(0, 6) }]);
  expect(plan.create).toBe(2);
  expect(plan.pending[0]).toHaveLength(LOOKUP_TABLE_CAPACITY);
  expect(plan.pending[1]).toHaveLength(300 - 6 - LOOKUP_TABLE_CAPACITY);
  const empty = [{ key: Keypair.generate().publicKey, addresses: [], active: true }];
  const chunked = planLookupExtensions(empty, fresh.slice(0, 50));
  expect(chunked.extend.map((e) => e.addresses.length)).toEqual([LOOKUP_EXTEND_CHUNK, LOOKUP_EXTEND_CHUNK, 10]);
  // Deactivating tables are neither counted as containing entries nor extended.
  const inactive = [{ key: Keypair.generate().publicKey, addresses: fresh.slice(0, 10), active: false }];
  const replanned = planLookupExtensions(inactive, fresh.slice(0, 10));
  expect(replanned.missing).toHaveLength(10);
  expect(replanned.extend).toHaveLength(0);
  expect(replanned.create).toBe(1);
});

test("keeper tables are read at finalized, and deactivating or foreign accounts are never referenced", async () => {
  const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:1", genesisHash: "x", config: Keypair.generate().publicKey.toBase58() });
  const entries = [Keypair.generate().publicKey];
  const active = table(entries), deactivating = table(entries, 100n), foreign = Keypair.generate().publicKey;
  const encode = (t: AddressLookupTableAccount) => {
    const data = Buffer.alloc(56 + 32 * t.state.addresses.length);
    data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE(t.state.deactivationSlot, 4);
    t.state.addresses.forEach((a, i) => a.toBuffer().copy(data, 56 + 32 * i));
    return data;
  };
  let commitment: unknown,
    reads = 0,
    fail = false;
  client.connection.getMultipleAccountsInfo = async (keys, c) => {
    commitment = c;
    reads++;
    if (fail) throw new Error("rpc down");
    return keys.map((k) =>
      k.equals(active.key) ? { data: encode(active), owner: AddressLookupTableProgram.programId, lamports: 1, executable: false }
        : k.equals(deactivating.key) ? { data: encode(deactivating), owner: AddressLookupTableProgram.programId, lamports: 1, executable: false }
          : k.equals(foreign) ? { data: encode(active), owner: Keypair.generate().publicKey, lamports: 1, executable: false }
            : null,
    );
  };
  client.useLookupTables([active.key, deactivating.key, foreign, Keypair.generate().publicKey].map(String));
  const tables = await client.lookupTables();
  expect(commitment).toBe("finalized");
  expect(tables.map((t) => t.key.toBase58())).toEqual([active.key.toBase58()]);
  expect(tables[0]!.state.addresses.map(String)).toEqual(entries.map(String));
  expect(client.keeperLookupTableAddresses()).toHaveLength(4);
  // Placements reuse the read for a short window; concurrent ones share it.
  await Promise.all([client.lookupTables(), client.lookupTables()]);
  expect(reads).toBe(1);
  client.keeperTableTtlMs = 0;
  await client.lookupTables();
  expect(reads).toBe(2);
  // A failed read is not cached; a changed table list is re-read at once.
  fail = true;
  await expect(client.lookupTables()).rejects.toThrow("rpc down");
  fail = false;
  client.keeperTableTtlMs = 60_000;
  expect((await client.lookupTables()).map((t) => t.key.toBase58())).toEqual([active.key.toBase58()]);
  client.useLookupTables([active.key].map(String));
  await client.lookupTables();
  expect(reads).toBe(5);
  expect(() => client.useLookupTables(Array.from({ length: 65 }, () => Keypair.generate().publicKey.toBase58()))).toThrow();
  expect(() => client.useLookupTables(["not-a-key"])).toThrow();
  // Keeper tables compile placements exactly like any other table.
  const message = new TransactionMessage({ payerKey: entries[0]!, recentBlockhash: SIZING_BLOCKHASH, instructions: [] }).compileToV0Message(tables);
  expect(message.addressTableLookups).toHaveLength(0);
});

test("participant and market address sets cover every placement account a maker adds", () => {
  const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:1", genesisHash: "x", config: Keypair.generate().publicKey.toBase58() });
  const market = Keypair.generate().publicKey;
  const m = marketAccount({ config: client.config, market, program: client.program, legs: 3 });
  // market + per collateral (mint, pool, vault, 2 claim mints, 2 claim vaults)
  expect(marketLookupAddresses(client.config, market, m, client.program)).toHaveLength(1 + 4 * 7);
  const owner = Keypair.generate().publicKey, delegate = Keypair.generate().publicKey;
  // wallet, trader, a credit frame per collateral, delegation grant
  expect(participantLookupAddresses(client.config, market, m, owner, [delegate], client.program)).toHaveLength(2 + 4 + 1);
  // With keeper tables no maker participant account is a static key: only the
  // signer, two programs, the new taker order, the maker orders themselves and
  // the (not yet resting) taker's own wallet, trader and credit frame remain.
  const c = crossing(MAX_MAKERS, 3, 0, 0);
  const message = c.compile([c.deployment, c.participants]);
  const plan = c.plan();
  const makerOrders = new Set(plan.makers.map((o) => orderId(o)));
  const statics = message.staticAccountKeys.map(String).filter((k) => !makerOrders.has(k));
  expect(statics).toHaveLength(7);
  const makerPdas = new Set(
    plan.makers.flatMap((o) =>
      participantLookupAddresses(c.client.config, new PublicKey(o.marketId), marketAccount({ config: c.client.config, market: new PublicKey(o.marketId), legs: 3 }), new PublicKey(o.maker), [], c.client.program)
        .slice(0, 2)
        .map(String),
    ),
  );
  expect(statics.some((k) => makerPdas.has(k))).toBe(false);
});
