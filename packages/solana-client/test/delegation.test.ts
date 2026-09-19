import { expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  SolanaClient,
  delegationAddress,
  orderSalt,
  digest,
  parseOrder,
  coder,
  bn,
  planOrder,
  computeUnits,
  validateDelegateLimits,
  activeDelegation,
  assertDelegatedOrder,
  type DelegateLimits,
  type TradingDelegateAccount,
  type OrderWire,
} from "../src/index";

function fixture() {
  const owner = Keypair.generate().publicKey,
    delegate = Keypair.generate().publicKey,
    market = Keypair.generate().publicKey,
    config = Keypair.generate().publicKey;
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8911",
    config: config.toBase58(),
    genesisHash: "test",
  });
  client.rememberMarket(market, {
    config,
    mints: [Keypair.generate().publicKey, Keypair.generate().publicKey],
  });
  const order: OrderWire = {
    maker: owner.toBase58(),
    delegate: delegate.toBase58(),
    recipient: owner.toBase58(),
    marketId: market.toBase58(),
    salt: orderSalt(0n, digest("delegate")),
    quantity: "10",
    limitPriceRawX18: String(2n * 10n ** 18n),
    expiry: "200",
    nonce: "0",
    maxFeeBps: 50,
    branch: 0,
    side: 0,
    fundingKind: 0,
    tif: 0,
  };
  const grant: TradingDelegateAccount = {
    config,
    owner,
    delegate,
    market: PublicKey.default,
    epoch: bn(2),
    expires_at: bn(200),
    max_order_quote: bn(20),
    remaining_quote: bn(40),
    max_fee_bps: 50,
    permissions: 3,
    revoked: false,
    bump: 1,
  };
  const limits: DelegateLimits = {
    market: null,
    expiresAt: 101n,
    maxOrderQuote: 20n,
    totalQuote: 40n,
    maxFeeBps: 50,
    permissions: 3,
  };
  return { client, owner, delegate, market, config, order, grant, limits };
}
test("grant builders require explicit scope, signer separation and owner-only management", () => {
  const f = fixture(),
    limits = { ...f.limits, expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 3600n };
  const ix = f.client.approveDelegate(f.owner, f.delegate, limits);
  expect(coder.instruction.decode(ix.data)?.name).toBe("approve_delegate");
  expect(ix.keys.filter((k) => k.isSigner).map((k) => String(k.pubkey))).toEqual([String(f.owner)]);
  expect(ix.keys[5]!.pubkey.equals(f.client.program)).toBe(true);
  expect(ix.keys[5]!.isWritable).toBe(false);
  expect(
    f.client
      .approveDelegate(f.owner, f.delegate, { ...limits, market: f.market })
      .keys[5]!.pubkey.equals(f.market),
  ).toBe(true);
  expect(ix.keys[4]!.pubkey.equals(delegationAddress(f.config, f.owner, f.delegate))).toBe(true);
  for (const method of [
    f.client.revokeDelegate(f.owner, f.delegate),
    f.client.revokeAllDelegates(f.owner),
  ])
    expect(method.keys.filter((k) => k.isSigner).map((k) => String(k.pubkey))).toEqual([
      String(f.owner),
    ]);
  for (const key of [PublicKey.default, f.owner])
    expect(() => f.client.approveDelegate(f.owner, key, limits)).toThrow();
  expect(() => validateDelegateLimits({ ...f.limits, market: undefined as never }, 100n)).toThrow();
});
test("delegation lifetime, permission bits and integer budgets fail closed", () => {
  const { limits } = fixture();
  validateDelegateLimits(limits, 100n);
  for (const changes of [
    { expiresAt: 100n },
    { expiresAt: 100n + 90n * 24n * 3600n + 1n },
    { maxOrderQuote: 0n },
    { totalQuote: 19n },
    { totalQuote: 1n << 64n },
    { maxFeeBps: 1001 },
    { maxFeeBps: 0.5 },
    { permissions: 0 },
    { permissions: 2 },
    { permissions: 255 },
  ])
    expect(() => validateDelegateLimits({ ...limits, ...changes }, 100n)).toThrow();
  validateDelegateLimits({ ...limits, expiresAt: 100n + 90n * 24n * 3600n, permissions: 1 }, 100n);
});
test("order wire keeps the beneficial owner distinct from the constrained signer", () => {
  const f = fixture();
  expect(parseOrder(f.order)).toEqual(f.order);
  for (const changes of [
    { delegate: f.owner.toBase58() },
    { delegate: PublicKey.default.toBase58() },
    { recipient: f.delegate.toBase58() },
    { salt: "0x" + "00".repeat(32) },
    { nonce: "1" },
  ])
    expect(() => parseOrder({ ...f.order, ...changes })).toThrow();
  const plan = planOrder({
    order: f.order,
    candidates: [],
    now: 100n,
    step: 1n,
    nextSequence: 0n,
    makerFeeBps: 0,
    takerFeeBps: 0,
  });
  const ix = f.client.placement(f.order, plan);
  expect(ix.keys[0]!.pubkey.equals(f.delegate)).toBe(true);
  expect(ix.keys[0]!.isSigner).toBe(true);
  expect(ix.keys[1]!.pubkey.equals(f.owner)).toBe(true);
  expect(ix.keys[1]!.isSigner).toBe(false);
  expect(ix.keys[11]!.pubkey.equals(delegationAddress(f.config, f.owner, f.delegate))).toBe(true);
  expect(ix.keys[11]!.isWritable).toBe(true);
  expect(computeUnits([ix], f.client.program)).toBe(129_000);
  const direct = { ...f.order };
  delete direct.delegate;
  const normal = f.client.placement(direct, plan);
  expect(normal.keys[11]!.pubkey.equals(f.client.program)).toBe(true);
  expect(normal.keys[11]!.isWritable).toBe(false);
});
test("indexed review checks grants without RPC; exhausted budgets do not hide existing maker liquidity", () => {
  const f = fixture();
  assertDelegatedOrder(f.order, f.grant, 2n, f.config, 100n);
  for (const grant of [
    undefined,
    { ...f.grant, revoked: true },
    { ...f.grant, epoch: bn(1) },
    { ...f.grant, expires_at: bn(100) },
    { ...f.grant, owner: f.delegate },
    { ...f.grant, delegate: f.owner },
    { ...f.grant, config: f.market },
    { ...f.grant, market: f.config },
    { ...f.grant, max_fee_bps: 49 },
    { ...f.grant, remaining_quote: bn(19) },
    { ...f.grant, max_order_quote: bn(19) },
  ])
    expect(() => assertDelegatedOrder(f.order, grant, 2n, f.config, 100n)).toThrow();
  expect(activeDelegation({ ...f.grant, remaining_quote: bn(0) }, 2n, f.market, 199n)).toBe(true);
  expect(activeDelegation(f.grant, 2n, f.market, 200n)).toBe(false);
  expect(activeDelegation(f.grant, 3n, f.market, 100n)).toBe(false);
});
test("delegated cancellation keeps owner refund accounts and never permits delegated retirement or deposits", async () => {
  const f = fixture(),
    address = Keypair.generate().publicKey;
  const ix = f.client.orderMaintenance(
    "cancel_orders",
    f.market,
    f.owner,
    [address],
    [1],
    f.delegate,
  );
  expect(ix.keys[0]!.pubkey.equals(f.delegate)).toBe(true);
  expect(ix.keys[1]!.pubkey.equals(f.owner)).toBe(true);
  expect(ix.keys[1]!.isSigner).toBe(false);
  expect(() =>
    f.client.orderMaintenance("retire_orders", f.market, f.owner, [address], [], f.delegate),
  ).toThrow();
  await expect(f.client.funding(f.order)).rejects.toThrow("deposited balances only");
});
