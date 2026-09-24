import { expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  bn,
  coder,
  orderId,
  orderWire,
  type OrderAccount,
} from "@conditional-stocks/solana-client";
import { retiredOrderImages, restoreRetiredOrders } from "../src/retired-orders";
import type { Snapshot } from "../src/projection";

test("retired orders rebuild history without entering the live RPC account image", async () => {
  const market = Keypair.generate().publicKey,
    owner = Keypair.generate().publicKey;
  const order: OrderAccount = {
    delegate: PublicKey.default,
    market,
    owner,
    remaining: bn(0),
    filled: bn(9),
    reserved: bn(0),
    open_notional: bn(0),
    sequence: bn(7),
    fee_carry: 0,
    status: 3,
    bump: 1,
    terms: {
      recipient: owner,
      salt: Array(32).fill(3),
      quantity: bn(10),
      price: bn(10n ** 18n),
      expiry: bn(100),
      nonce: bn(0),
      max_fee_bps: 0,
      branch: 0,
      side: 0,
      funding: 0,
      tif: 0,
      bases: 1,
    },
  };
  const address = orderId(orderWire(order));
  const image = await coder.accounts.encode("Order", order);
  const images = retiredOrderImages([{ data: { account: address, data: [...image] } }]);
  const snapshot = () =>
    ({
      program: PROGRAM_ID,
      markets: new Map([[market.toBase58(), {}]]),
      orders: new Map(),
      rawAccounts: [],
    }) as unknown as Snapshot;
  const s = snapshot();
  restoreRetiredOrders(s, images);
  expect(s.orders.get(address)?.filled.toString()).toBe("9");
  expect(s.orders.get(address)?.status).toBe(3);
  expect(s.rawAccounts).toEqual([]);
  expect(() => restoreRetiredOrders(s, images)).toThrow("unexpectedly exists");
  for (const patch of [
    { status: 1 },
    { remaining: bn(1) },
    { reserved: bn(1) },
    { open_notional: bn(1) },
    { owner: Keypair.generate().publicKey },
  ]) {
    const data = (await coder.accounts.encode("Order", { ...order, ...patch })).toString("base64");
    expect(() => restoreRetiredOrders(snapshot(), [{ address, data }])).toThrow();
  }
  expect(() => retiredOrderImages([{ data: { account: address, data: [256] } }])).toThrow();
});
