import { expect, test } from "bun:test";
import {
  AddressLookupTableAccount,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  SolanaClient,
  WAD,
  orderSalt,
  boundOrderNonce,
  parseOrder,
  planOrder,
  orderId,
  envelope,
  computeUnits,
  compileTransactionMessage,
  budgetedInstructions,
  SIZING_BLOCKHASH,
  UNIT_MULTIPLIER,
  type OrderWire,
} from "../src/index";
import { marketAccount } from "./market-fixture";

function fixture(count = 8, funding = 0, recipients = false) {
  const owner = Keypair.generate().publicKey,
    market = Keypair.generate().publicKey;
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8899",
    genesisHash: "test",
    config: Keypair.generate().publicKey.toBase58(),
  });
  client.rememberMarket(market, marketAccount({ config: client.config, market }));
  const order: OrderWire = {
    maker: owner.toBase58(),
    recipient: (recipients ? Keypair.generate().publicKey : owner).toBase58(),
    marketId: market.toBase58(),
    salt: orderSalt(1n, crypto.getRandomValues(new Uint8Array(32))),
    quantity: String(Math.max(1, count) * 100),
    limitPriceRawX18: String(2n * WAD),
    expiry: "99999",
    nonce: "1",
    branch: 0,
    side: 0,
    tif: 0,
    fundingKind: funding,
    maxFeeBps: 1000,
    bases: 1,
  };
  const makers = Array.from({ length: count }, () => {
    const maker = Keypair.generate().publicKey.toBase58();
    return {
      ...order,
      maker,
      recipient: recipients ? Keypair.generate().publicKey.toBase58() : maker,
      side: 1,
      quantity: "100",
    };
  });
  const plan = planOrder({
    order,
    candidates: makers.map((o, i) => ({
      order: o,
      orderHash: orderId(o),
      remaining: 100n,
      reserved: 100n,
      sequence: BigInt(i),
    })),
    legs: { 1: { scale: 1n, multiplier: UNIT_MULTIPLIER, tradable: true } },
    now: 1n,
    step: 1n,
    nextSequence: BigInt(count),
    makerFeeBps: 10,
    takerFeeBps: 20,
  });
  return { client, owner, market, order, plan, ix: client.placement(order, plan) };
}

test("new salt binds the exact u64 nonce without reducing random suffix entropy", () => {
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  for (const nonce of [0n, 1n, (1n << 64n) - 1n]) {
    const salt = orderSalt(nonce, entropy);
    expect(boundOrderNonce(salt)).toBe(nonce);
    expect(salt.slice(-32)).toBe(Buffer.from(entropy.subarray(16)).toString("hex"));
    const f = fixture(0);
    expect(parseOrder({ ...f.order, salt, nonce: String(nonce) }).nonce).toBe(String(nonce));
    expect(() => parseOrder({ ...f.order, salt, nonce: String(nonce === 0n ? 1n : 0n) })).toThrow(
      "nonce differs",
    );
  }
  expect(boundOrderNonce(new Uint8Array(32))).toBeNull();
  expect(() => orderSalt(-1n, entropy)).toThrow();
  expect(() => orderSalt(1n << 64n, entropy)).toThrow();
  expect(() => orderSalt(0n, entropy.subarray(1))).toThrow();
});

test("no-mint routes use readonly token accounts; mixed funding writes only affected collateral", () => {
  // Named 10, quote claims 10..14, then 7 accounts for the one touched leg.
  const resting = fixture(0);
  expect(resting.ix.keys).toHaveLength(10 + 4 + 2 + 1);
  expect(resting.ix.keys.slice(10, 14).every((a) => !a.isWritable)).toBe(true);
  const claims = fixture(8, 1);
  expect(claims.ix.keys.slice(10, 21).every((a) => !a.isWritable)).toBe(true);
  expect(claims.ix.keys.slice(21, 21 + claims.plan.makers.length).every((a) => a.isWritable)).toBe(true);
  const f = fixture(1, 1);
  const maker = { ...f.plan.makers[0]!, fundingKind: 0 };
  const ix = f.client.placement(f.order, { ...f.plan, makers: [maker] });
  // Quote claims readonly (claim-funded buyer); the leg's pool, vault and mint
  // readonly; the leg's claim mints/vaults writable (underlying-funded ask).
  expect(ix.keys.slice(10, 14).every((a) => !a.isWritable)).toBe(true);
  expect(ix.keys.slice(14, 17).every((a) => !a.isWritable)).toBe(true);
  expect(ix.keys.slice(17, 21).every((a) => a.isWritable)).toBe(true);
});

test("eight-maker sizing rejects early without LUTs and fits with frozen address tables", async () => {
  const f = fixture(8, 0, false);
  const instructions = budgetedInstructions([f.ix], f.client.program);
  // 100k base + 35k one leg + 8k taker frame + 8 x 11k legs + 9 x 6k participants + 4 x 8k minting claims.
  expect(computeUnits([f.ix], f.client.program)).toBe(317_000);
  expect(() => compileTransactionMessage(f.owner, instructions, SIZING_BLOCKHASH)).toThrow(
    "packet limit",
  );
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: f.ix.keys.filter((a) => !a.isSigner).map((a) => a.pubkey),
    },
  });
  const message = compileTransactionMessage(f.owner, instructions, SIZING_BLOCKHASH, [table]);
  expect(new VersionedTransaction(message).serialize().length).toBeLessThanOrEqual(1232);
  const recovered = TransactionMessage.decompile(message, { addressLookupTableAccounts: [table] });
  expect(recovered.instructions.at(-1)!.data).toEqual(f.ix.data);
  expect(recovered.instructions.at(-1)!.keys.map((a) => String(a.pubkey))).toEqual(
    f.ix.keys.map((a) => String(a.pubkey)),
  );
  let blocks = 0;
  f.client.assertNetwork = async () => {};
  f.client.connection.getLatestBlockhash = async () => {
    blocks++;
    return { blockhash: SIZING_BLOCKHASH, lastValidBlockHeight: 1 };
  };
  await expect(f.client.prepareTransaction(f.owner, envelope([f.ix]))).rejects.toThrow(
    "packet limit",
  );
  expect(blocks).toBe(0);
});

test("lookup cache coalesces requests across clients, requires frozen active tables, retries failures", async () => {
  const f = fixture(0),
    address = Keypair.generate().publicKey;
  const deployment = { ...f.client.deployment, addressLookupTables: [address.toBase58()] };
  const client = new SolanaClient(deployment),
    other = new SolanaClient(deployment);
  let calls = 0;
  let mutable = true;
  client.connection.getAddressLookupTable = other.connection.getAddressLookupTable = async () => {
    calls++;
    return {
      context: { slot: 2 },
      value: new AddressLookupTableAccount({
        key: address,
        state: {
          deactivationSlot: (1n << 64n) - 1n,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: [],
          ...(mutable ? { authority: f.owner } : {}),
        },
      }),
    };
  };
  await expect(client.lookupTables()).rejects.toThrow("permanently frozen");
  mutable = false;
  await Promise.all([client.lookupTables(), other.lookupTables(), client.lookupTables()]);
  expect(calls).toBe(2);
  await new SolanaClient(deployment).lookupTables();
  expect(calls).toBe(2);
});

test("bounded maintenance instructions use indexed addresses with no account reads", () => {
  const f = fixture(0),
    keys = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
  f.client.connection.getAccountInfo = async () => {
    throw new Error("unexpected RPC");
  };
  const ix = f.client.orderMaintenance("retire_orders", f.market, f.owner, keys, [0, 3]);
  expect(ix.keys).toHaveLength(16);
  expect(computeUnits([ix], f.client.program)).toBe(170_000);
  expect(() => f.client.orderMaintenance("cancel_orders", f.market, f.owner, [])).toThrow();
  expect(() =>
    f.client.orderMaintenance("cancel_orders", f.market, f.owner, [...keys, keys[0]!]),
  ).toThrow();
  expect(() =>
    f.client.orderMaintenance("cancel_orders", f.market, f.owner, [keys[0]!, keys[0]!]),
  ).toThrow();
});

test("lookup compression cannot bypass the account lock limit or compute ceiling", () => {
  const f = fixture(0);
  const addresses = Array.from({ length: 63 }, () => Keypair.generate().publicKey);
  const instruction = new TransactionInstruction({
    programId: f.client.program,
    keys: addresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    data: Buffer.alloc(0),
  });
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses,
    },
  });
  expect(() =>
    compileTransactionMessage(f.owner, [instruction], SIZING_BLOCKHASH, [table]),
  ).toThrow("account limit");
  const batch = f.client.orderMaintenance(
    "cancel_orders",
    f.market,
    f.owner,
    addresses.slice(0, 8),
  );
  expect(() =>
    computeUnits(
      Array.from({ length: 10 }, () => batch),
      f.client.program,
    ),
  ).toThrow("compute budget exceeds limit");
});
