import { expect, test } from "bun:test";
import {
  PublicKey,
  UNIT_MULTIPLIER,
  bn,
  claimAsset,
  legAccounts,
  legStates,
  multiplierBits,
  orderId,
  orderWire,
  underlyingAsset,
  walletAddress,
  type OrderAccount,
} from "@conditional-stocks/solana-client";
import { indexedOrder, liveOrder, marketView } from "../src/projection";
import { persistSnapshot } from "../src/storage";
import { custodyFixture } from "./custody-fixture";
import { legInfos } from "./live-fixture";

const DEFAULT = "11111111111111111111111111111111";

function order(
  s: ReturnType<typeof custodyFixture>["s"],
  market: string,
  owner: PublicKey,
  side: number,
  bases: number,
  salt = 1,
): [string, OrderAccount] {
  const o = {
    market: new PublicKey(market),
    owner,
    delegate: PublicKey.default,
    remaining: bn(10),
    filled: bn(0),
    reserved: bn(0),
    open_notional: bn(0),
    sequence: bn(salt),
    fee_carry: 0,
    status: 1,
    bump: 0,
    terms: {
      recipient: owner,
      salt: Array(32).fill(salt),
      quantity: bn(10),
      price: bn(10n ** 17n),
      expiry: bn(9_999_999_999),
      nonce: bn(0),
      max_fee_bps: 0,
      branch: 0,
      side,
      funding: 1,
      tif: 0,
      bases,
    },
  } as OrderAccount;
  return [orderId(orderWire(o), s.program), o];
}

test("market view publishes the protocolVersion 3 multi-issuer contract", () => {
  const { s, bases, quote } = custodyFixture(3);
  const [id, m] = [...s.markets][0]!;
  m.decimals = [6, 8, 9, 9];
  m.legs[0]!.scale = bn(100);
  m.legs[1]!.scale = bn(1000);
  m.legs[1]!.multiplier = bn(multiplierBits(1.0017));
  m.legs[2]!.active = false;
  const view = marketView(id, m, "2026-09-23T00:00:00.000Z");
  expect(view).toMatchObject({
    id,
    createdAt: "2026-09-23T00:00:00.000Z",
    conditionId: id,
    quoteToken: String(quote),
    quoteTokenDecimals: 6,
    shareDecimals: 6,
    quoteClaimMints: { yes: String(m.mints[1]), no: String(m.mints[2]) },
    protocolVersion: 3,
    priceFormat: "share-unit-ratio-x18",
  });
  expect(view.claimMints).toEqual(m.mints.map(String));
  expect(view.claimMints).toHaveLength(12);
  expect(view.bases).toEqual([
    {
      collateral: 1,
      bit: 1,
      mint: String(bases[0]),
      decimals: 8,
      scale: "100",
      listingMultiplier: UNIT_MULTIPLIER.toString(),
      active: true,
      ready: true,
      claimMints: { yes: String(m.mints[4]), no: String(m.mints[5]) },
    },
    {
      collateral: 2,
      bit: 2,
      mint: String(bases[1]),
      decimals: 9,
      scale: "1000",
      listingMultiplier: multiplierBits(1.0017).toString(),
      active: true,
      ready: true,
      claimMints: { yes: String(m.mints[7]), no: String(m.mints[8]) },
    },
    {
      collateral: 3,
      bit: 4,
      mint: String(bases[2]),
      decimals: 9,
      scale: "1",
      listingMultiplier: UNIT_MULTIPLIER.toString(),
      active: false,
      ready: true,
      claimMints: { yes: String(m.mints[10]), no: String(m.mints[11]) },
    },
  ]);
  for (const legacy of ["baseToken", "baseTokenDecimals", "stockYes"])
    expect(view).not.toHaveProperty(legacy);
  // Unlisted collaterals are the default key and have no base entry.
  const single = custodyFixture(1);
  const [singleId, one] = [...single.s.markets][0]!;
  const partial = marketView(singleId, one);
  expect(partial.bases).toHaveLength(1);
  expect(partial.claimMints.slice(6)).toEqual(Array(6).fill(DEFAULT));
  one.vaults_initialized &= ~(1 << claimAsset(1, 1));
  expect(marketView(singleId, one).bases[0]!.ready).toBe(false);
});

test("indexed orders carry the leg mask; sells name the delivered collateral", () => {
  const { s, owner } = custodyFixture(3);
  const [id] = [...s.markets][0]!;
  const [askId, ask] = order(s, id, owner, 1, 0b100);
  const [bidId, bid] = order(s, id, owner, 0, 0b011, 2);
  expect(indexedOrder(askId, ask, 100)).toMatchObject({ bases: 4, baseCollateral: 3, side: 1 });
  expect(indexedOrder(bidId, bid, 100)).toMatchObject({ bases: 3, baseCollateral: null, side: 0 });
});

test("asks on a delisted leg are not live liquidity; bids and other legs are unaffected", () => {
  const { s, owner } = custodyFixture(3);
  const [id, m] = [...s.markets][0]!;
  s.traders.set(String(owner), { minimum_nonce: bn(0), delegation_epoch: bn(0) } as never);
  const now = 1_000n;
  const [, ask2] = order(s, id, owner, 1, 0b010);
  const [, ask1] = order(s, id, owner, 1, 0b001, 2);
  const [, bid] = order(s, id, owner, 0, 0b010, 3);
  expect([ask2, ask1, bid].map((o) => liveOrder(o, s, now))).toEqual([true, true, true]);
  m.legs[1]!.active = false;
  expect([ask2, ask1, bid].map((o) => liveOrder(o, s, now))).toEqual([false, true, true]);
  // A leg beyond the listed count can never deliver either.
  m.bases = 1;
  expect(liveOrder(ask2, s, now)).toBe(false);
  expect(s.wallets.has(String(walletAddress(new PublicKey(id), owner, s.program)))).toBe(true);
});

test("live leg state from streamed issuer accounts drives the market view", () => {
  const { s, bases, config } = custodyFixture(3);
  const [first, second] = [...s.markets.keys()];
  s.markets.get(first!)!.legs[2]!.active = false;
  const accounts = legInfos(bases, config, s.program, [1]);
  const legs = (id: string) => {
    const market = s.markets.get(id)!;
    return legStates(market, legAccounts(market, config, s.program).map((k) => accounts.get(String(k)) ?? null), config, s.program);
  };
  expect(Object.values(legs(first!)).map((l) => [l.collateral, l.tradable, l.halt])).toEqual([
    [1, true, null],
    [2, false, "vault-frozen"],
    [3, false, "delisted"],
  ]);
  expect(legs(second!)[3]!.tradable).toBe(true);
  const view = marketView(first!, s.markets.get(first!)!, undefined, legs(first!));
  expect(view.bases.map((b) => b.live)).toEqual([
    {
      multiplier: UNIT_MULTIPLIER.toString(),
      multiplierValue: 1,
      paused: false,
      vaultFrozen: false,
      tradable: true,
      halt: null,
    },
    {
      multiplier: UNIT_MULTIPLIER.toString(),
      multiplierValue: 1,
      paused: false,
      vaultFrozen: true,
      tradable: false,
      halt: "vault-frozen",
    },
    {
      multiplier: UNIT_MULTIPLIER.toString(),
      multiplierValue: 1,
      paused: false,
      vaultFrozen: false,
      tradable: false,
      halt: "delisted",
    },
  ]);
  // An unreadable issuer mint halts only that leg.
  accounts.delete(String(bases[0]));
  expect(legs(second!)[1]!.halt).toBe("unreadable");
  expect(legs(second!)[2]!.halt).toBe("vault-frozen");
});

test("persisted snapshots store claim credit of every listed collateral with live market views", async () => {
  const { s, owner } = custodyFixture(2);
  const [id, m] = [...s.markets][0]!;
  const wallet = s.wallets.get(String(walletAddress(new PublicKey(id), owner, s.program)))!;
  let written: Parameters<Parameters<typeof persistSnapshot>[0]["persistSnapshot"]>[1] | undefined;
  const db = {
    persistSnapshot: async (_domain: string, image: typeof written) => {
      written = image;
      return true;
    },
  };
  s.legs = new Map([
    [
      id,
      {
        1: { multiplier: UNIT_MULTIPLIER, multiplierValue: 1, paused: true, vaultFrozen: false, tradable: false, halt: "issuer-paused" } as never,
      },
    ],
  ]);
  expect(await persistSnapshot(db as never, "domain", s, [])).toBe(true);
  const rows = written!.claims.filter((c) => c.market === id);
  expect(rows.map((r) => r.asset)).toEqual([1, 2, 4, 5, 7, 8]);
  expect(rows.find((r) => r.asset === 4)).toMatchObject({
    owner: String(owner),
    mint: String(m.mints[4]),
    available: String(wallet.balances[4]),
  });
  const markets = (written!.accounts as { markets: ReturnType<typeof marketView>[] }).markets;
  expect(markets.find((v) => v.id === id)!.bases[0]!.live).toMatchObject({
    paused: true,
    halt: "issuer-paused",
  });
  expect(m.mints[underlyingAsset(3)]!.toBase58()).toBe(DEFAULT);
});
