import { expect, test } from "bun:test";
import {
  bn,
  bytes32,
  type LiveLeg,
  type OrderAccount,
  type OrderWire,
  orderId,
  orderSalt,
  orderWire,
  PublicKey,
  SolanaClient,
  UNIT_MULTIPLIER,
  unwrap,
  walletAddress,
} from "@conditional-stocks/solana-client";
import { TransactionInstruction } from "@solana/web3.js";
import { custodyFixture } from "../../../../services/solana-indexer/test/custody-fixture";
import { assertOrderLegs, createOrderPlan } from "../../src/solana/trading/plan.ts";

const WAD = 10n ** 18n;
const expiry = 9_000_000_000n;

function book(legs = 3) {
  const f = custodyFixture(legs);
  const [marketId, market] = [...f.s.markets][0]!;
  market.sequence = [bn(100), bn(100)];
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:1",
    genesisHash: "test",
    config: String(f.config),
    programId: String(f.s.program),
  });
  let sequence = 0;
  /** A resting maker order from a fresh owner with a wallet and trader. */
  const rest = (side: number, bases: number, price: bigint, remaining = 10n, reserved = 10n) => {
    const owner = PublicKey.unique();
    f.s.traders.set(String(owner), { minimum_nonce: bn(0), delegation_epoch: bn(0) } as never);
    f.s.wallets.set(String(walletAddress(new PublicKey(marketId), owner, f.s.program)), {
      market: new PublicKey(marketId),
      owner,
      balances: Array.from({ length: 12 }, () => bn(0)),
      open_notional: bn(0),
      bump: 0,
    });
    const order = {
      market: new PublicKey(marketId),
      owner,
      delegate: PublicKey.default,
      remaining: bn(remaining),
      filled: bn(0),
      reserved: bn(reserved),
      open_notional: bn(0),
      sequence: bn(sequence++),
      fee_carry: 0,
      status: 1,
      bump: 0,
      terms: {
        recipient: owner,
        salt: [...bytes32(orderSalt(0n, new Uint8Array(32).fill(sequence)))],
        quantity: bn(remaining),
        price: bn(price),
        expiry: bn(expiry),
        nonce: bn(0),
        max_fee_bps: 0,
        branch: 0,
        side,
        funding: 1,
        tif: 0,
        bases,
      },
    } as OrderAccount;
    f.s.orders.set(orderId(orderWire(order), f.s.program), order);
    return order;
  };
  const taker = PublicKey.unique().toBase58();
  let takers = 0;
  const order = (side: number, bases: number, quantity: bigint, price: bigint): OrderWire => ({
    maker: taker,
    recipient: taker,
    marketId,
    salt: orderSalt(1n, new Uint8Array(32).fill(200 + (takers++ % 50))),
    quantity: String(quantity),
    limitPriceRawX18: String(price),
    expiry: String(expiry),
    nonce: "1",
    maxFeeBps: 0,
    branch: 0,
    side,
    fundingKind: 1,
    tif: 0,
    bases,
  });
  const live: Record<number, LiveLeg> = {};
  for (let c = 1; c <= legs; c++)
    live[c] = {
      collateral: c,
      mint: String(f.bases[c - 1]),
      tradable: true,
      halt: null,
      scale: 1n,
      multiplier: UNIT_MULTIPLIER,
      multiplierValue: 1,
    } as LiveLeg;
  const reads: unknown[] = [];
  const prepare = createOrderPlan(client, () => f.s, async (m) => {
    reads.push(m);
    return live;
  });
  return { ...f, client, market, marketId, rest, order, live, prepare, reads };
}

test("bids fill only accepted, tradable issuer legs and pass indexed reservations", async () => {
  const b = book();
  b.client.assertTransactionFits = async () => {};
  b.rest(1, 0b001, 3n * WAD / 10n); // NVDAx, cheapest, not accepted
  const on = b.rest(1, 0b010, 4n * WAD / 10n, 10n, 12n); // NVDAon, reserve surplus
  const r = b.rest(1, 0b100, 45n * WAD / 100n); // NVDAr, exact reserve
  const result = await b.prepare(b.order(0, 0b110, 15n, WAD / 2n), b.s);
  expect(b.reads).toHaveLength(1);
  expect(result.plan.makers.map((m) => m.bases)).toEqual([0b010, 0b100]);
  expect(result.plan.makers[0]!.maker).toBe(String(on.owner));
  expect(result.plan.makers[1]!.maker).toBe(String(r.owner));
  expect(result.plan.quantities).toEqual(["10", "5"]);
  // Reserves were known for every ask: the completing NVDAon ask refunds.
  expect(result.plan.surplus).toEqual([true, false]);
  expect(result.legs[2]).toMatchObject({ tradable: true, multiplierValue: 1 });
  // A halted leg delivers nothing, even when the bid accepts it.
  b.live[2] = { ...b.live[2]!, tradable: false, halt: "issuer-paused" };
  const halted = await b.prepare(b.order(0, 0b111, 15n, WAD / 2n), b.s);
  expect(halted.plan.makers.map((m) => m.bases)).toEqual([0b001, 0b100]);
  // An ask whose reservation no longer covers the live conversion is skipped.
  b.live[3] = { ...b.live[3]!, multiplier: 0x3fe0_0000_0000_0000n, multiplierValue: 0.5 };
  const shrunk = await b.prepare(b.order(0, 0b100, 10n, WAD / 2n), b.s);
  expect(shrunk.plan.makers).toEqual([]);
});

test("orders are rejected for unlisted, malformed or halted issuer legs", async () => {
  const b = book(2);
  b.client.assertTransactionFits = async () => {};
  await expect(b.prepare(b.order(0, 0b100, 10n, WAD / 2n), b.s)).rejects.toThrow("not listed");
  await expect(b.prepare(b.order(1, 0b100, 10n, WAD / 2n), b.s)).rejects.toThrow("not listed");
  b.live[2] = { ...b.live[2]!, tradable: false, halt: "vault-frozen" };
  await expect(b.prepare(b.order(1, 0b010, 10n, WAD / 2n), b.s)).rejects.toThrow(
    "halted (vault-frozen)",
  );
  // A buy is valid while at least one accepted leg is tradable.
  expect((await b.prepare(b.order(0, 0b011, 10n, WAD / 2n), b.s)).plan.makers).toEqual([]);
  b.live[1] = { ...b.live[1]!, tradable: false, halt: "corporate-action" };
  await expect(b.prepare(b.order(0, 0b011, 10n, WAD / 2n), b.s)).rejects.toThrow(
    "None of the accepted",
  );
  // Without live state, a sell of a delisted leg is still refused.
  b.market.legs[0]!.active = false;
  expect(() => assertOrderLegs({ side: 1, bases: 0b001 }, b.market)).toThrow("halted (delisted)");
  expect(() => assertOrderLegs({ side: 0, bases: 0b001 }, b.market)).not.toThrow();
  expect(() => assertOrderLegs({ side: 1, bases: 0b011 }, b.market)).toThrow("exactly one");
});

test("a plan too large for one transaction retries with fewer makers, never splitting", async () => {
  const b = book();
  const instruction = new TransactionInstruction({
    programId: b.s.program,
    keys: [],
    data: Buffer.from([1]),
  });
  let makers = 0;
  const fits: number[] = [];
  b.client.placement = (_order, plan) => {
    makers = plan.makers.length;
    return instruction;
  };
  b.client.assertTransactionFits = async (_payer, value) => {
    fits.push(unwrap(value, b.client.program).length);
    if (makers > 2)
      throw new Error(
        "Transaction exceeds the Solana packet limit; configure lookup tables or reduce the number of makers/instructions",
      );
  };
  for (const c of [1, 2, 4]) b.rest(1, c, 4n * WAD / 10n);
  // Two makers fit on the first attempt.
  const fitting = await b.prepare(b.order(0, 0b111, 20n, WAD / 2n), b.s);
  expect(fitting.plan.makers).toHaveLength(2);
  expect(fits).toEqual([1]);
  // Three makers do not fit, and a smaller cap cannot fill the order: fail
  // with the budget instead of splitting across transactions.
  await expect(b.prepare(b.order(0, 0b111, 30n, WAD / 2n), b.s)).rejects.toThrow(
    "at most 2 here",
  );
  // Immediate-or-cancel instead fills what fits and releases the remainder.
  const ioc = await b.prepare({ ...b.order(0, 0b111, 30n, WAD / 2n), tif: 1 }, b.s);
  expect(ioc.plan.makers).toHaveLength(2);
  expect(ioc.plan.filledQuantity).toBe("20");
  expect(ioc.plan.remainingQuantity).toBe("10");
  expect(ioc.lookupTables).toEqual([]);
  // Plans report the keeper tables they were sized with.
  b.client.useLookupTables([String(PublicKey.unique())]);
  expect((await b.prepare(b.order(0, 0b111, 10n, WAD / 2n), b.s)).lookupTables).toHaveLength(1);
  b.client.useLookupTables([]);
  // Shared-transaction instructions (a delegated wallet initializer) count too.
  fits.length = 0;
  await b.prepare(b.order(0, 0b111, 10n, WAD / 2n), b.s, [instruction, instruction]);
  expect(fits).toEqual([3]);
  // Other failures are never masked as a budget problem.
  b.client.assertTransactionFits = async () => {
    throw new Error("RPC offline");
  };
  await expect(b.prepare(b.order(0, 0b111, 30n, WAD / 2n), b.s)).rejects.toThrow("RPC offline");
});

test("real placement sizing: a one-maker multi-leg fill fits without lookup tables", async () => {
  const b = book();
  b.rest(1, 0b100, 4n * WAD / 10n);
  const result = await b.prepare(b.order(0, 0b111, 10n, WAD / 2n), b.s);
  expect(result.plan.makers).toHaveLength(1);
  expect(result.plan.makers[0]!.bases).toBe(0b100);
});
