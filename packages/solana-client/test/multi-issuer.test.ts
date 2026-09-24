import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { unpackMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  COLLATERALS,
  LEG_ACCOUNTS,
  MAX_BASES,
  UNIT_MULTIPLIER,
  WAD,
  acceptsLeg,
  allLegs,
  assetCreditAddress,
  baseRaw,
  bn,
  claimAddress,
  claimAsset,
  coder,
  collateralOf,
  computeUnits,
  decodeSupportedMint,
  fundingAsset,
  isClaimAsset,
  issuerState,
  legsOf,
  multiplierBits,
  multiplierParts,
  multiplierValue,
  orderCollateral,
  orderId,
  orderSalt,
  parseAtomicPlan,
  parseOrder,
  planOrder,
  poolAddress,
  poolVaultAddress,
  shareScale,
  singleBase,
  SolanaClient,
  underlyingAsset,
  vaultAddress,
  withinBand,
  type Candidate,
  type OrderWire,
} from "../src/index";
import { marketAccount } from "./market-fixture";

const fixture = (address: string) => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `mint-${address}.json`), "utf8"));
  const info = {
    data: Buffer.from(raw.data, "base64"),
    owner: new PublicKey(raw.owner),
    lamports: raw.lamports,
    executable: false,
    rentEpoch: 0,
  };
  return { address: new PublicKey(address), info };
};
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const NVDAON = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";
const NVDAR = "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu";
const SPCX = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";

test("asset layout: quote collateral 0, three issuer legs, underlying/YES/NO per collateral", () => {
  expect(COLLATERALS).toBe(4);
  expect(MAX_BASES).toBe(3);
  expect([0, 1, 2, 3].map(underlyingAsset)).toEqual([0, 3, 6, 9]);
  expect([0, 1, 2, 3].map((c) => [claimAsset(c, 0), claimAsset(c, 1)])).toEqual([[1, 2], [4, 5], [7, 8], [10, 11]]);
  for (let asset = 0; asset < 12; asset++) {
    expect(collateralOf(asset)).toBe(Math.floor(asset / 3));
    expect(isClaimAsset(asset)).toBe(asset % 3 !== 0);
  }
  expect(isClaimAsset(12)).toBe(false);
  expect([1, 2, 4].map(singleBase)).toEqual([1, 2, 3]);
  for (const mask of [0, 3, 5, 6, 7, 8, -1, 1.5]) expect(singleBase(mask)).toBeNull();
  expect(legsOf(0b101)).toEqual([1, 3]);
  expect(allLegs(3)).toBe(7);
});

test("multiplier decode is exact for real issuer values and rejects non-finite, negative and out-of-range bits", () => {
  for (const value of [1, 1.0009180758490996, 1.001701196801074, 1.0017152487959897, 1.0094730727840426, 0.5, 10, 2 ** -11, 2 ** 52 - 1]) {
    const bits = multiplierBits(value);
    const { mantissa, shift } = multiplierParts(bits);
    // mantissa / 2^shift reproduces the double exactly.
    expect(Number(mantissa) / 2 ** Number(shift)).toBe(value);
    expect(multiplierValue(bits)).toBe(value);
  }
  expect(multiplierBits(1)).toBe(UNIT_MULTIPLIER);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** -12, 2 ** 53, 5e-324])
    expect(() => multiplierParts(multiplierBits(bad))).toThrow();
});

test("baseRaw: identity at unit multiplier, floor/ceil bracket the exact rational, overflow rejected", () => {
  expect(baseRaw(123_456n, 100n, UNIT_MULTIPLIER)).toBe(12_345_600n);
  expect(baseRaw(123_456n, 100n, UNIT_MULTIPLIER, true)).toBe(12_345_600n);
  // NVDAx listing multiplier: 1 share unit (1e-6 share) at 8 decimals = 100 raw at 1.0.
  const m = multiplierBits(1.001701196801074);
  const { mantissa, shift } = multiplierParts(m);
  let seed = 7n;
  for (let i = 0; i < 2_000; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    const units = seed % 10n ** 12n;
    for (const scale of [1n, 100n, 1000n]) {
      const down = baseRaw(units, scale, m), up = baseRaw(units, scale, m, true);
      const numerator = (units * scale) << shift;
      expect(down).toBe(numerator / mantissa);
      expect(up - down).toBe(numerator % mantissa === 0n ? 0n : 1n);
      // Economic value: raw * multiplier never exceeds the shares paid for.
      expect(down * mantissa <= numerator).toBe(true);
    }
  }
  expect(() => baseRaw((1n << 64n) - 1n, 2n, UNIT_MULTIPLIER)).toThrow("u64");
  expect(() => baseRaw((1n << 63n), 1n, multiplierBits(0.5))).toThrow("u64");
  expect(shareScale(8, 6)).toBe(100n);
  expect(shareScale(9, 6)).toBe(1000n);
  expect(() => shareScale(5, 6)).toThrow();
});

test("dividend band is inclusive at 4/5 and 5/4 and excludes splits", () => {
  const listing = multiplierBits(1.25);
  expect(withinBand(listing, multiplierBits(1.25 * 1.25))).toBe(true);
  expect(withinBand(listing, multiplierBits(1.25 * 0.8))).toBe(true);
  expect(withinBand(listing, multiplierBits(1.25 * 1.2500001))).toBe(false);
  expect(withinBand(listing, multiplierBits(1.25 * 0.7999999))).toBe(false);
  for (const split of [2, 10, 0.5, 0.1]) expect(withinBand(listing, multiplierBits(1.25 * split))).toBe(false);
  expect(withinBand(UNIT_MULTIPLIER, multiplierBits(1.001701196801074))).toBe(true);
});

test("real mainnet issuer mints decode with their exact issuer controls", () => {
  const now = 1_790_000_000n;
  const expected: Record<string, { controls: number; decimals: number; multiplier: number }> = {
    [NVDAX]: { controls: 63, decimals: 8, multiplier: 1.001701196801074 },
    [NVDAON]: { controls: 62, decimals: 9, multiplier: 1.0017152487959897 },
    [NVDAR]: { controls: 47, decimals: 9, multiplier: 1 },
    [SPCX]: { controls: 63, decimals: 6, multiplier: 1 },
  };
  for (const [address, want] of Object.entries(expected)) {
    const { address: key, info } = fixture(address);
    expect(info.owner.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    const mint = decodeSupportedMint(key, info, 63, now);
    expect(mint.decimals).toBe(want.decimals);
    expect(mint.issuer.controls).toBe(want.controls);
    expect(mint.issuer.paused).toBe(false);
    expect(mint.issuer.transferHookProgram).toBeNull();
    expect(mint.issuer.defaultFrozen).toBe(false);
    expect(multiplierValue(mint.issuer.multiplier)).toBe(want.multiplier);
    // Exactly the admitted controls; nothing less.
    decodeSupportedMint(key, info, want.controls, now);
    for (let bit = 1; bit < 64; bit <<= 1)
      if (want.controls & bit) expect(() => decodeSupportedMint(key, info, want.controls & ~bit, now)).toThrow("Unsupported");
    expect(() => decodeSupportedMint(key, info, 0, now)).toThrow("Unsupported");
  }
  // NVDAx's scheduled multiplier applies only from its timestamp (2026-09-10 00:30 UTC).
  const { address, info } = fixture(NVDAX);
  const before = issuerState(unpackMint(address, info, TOKEN_2022_PROGRAM_ID).tlvData, 1_789_000_199n);
  expect(multiplierValue(before.multiplier)).toBe(1.0009180758490996);
  expect(before.nextMultiplier?.effectiveAt).toBe(1_789_000_200n);
});

test("paused issuer tokens and configured transfer hooks are surfaced before custody transfers", () => {
  const { address, info } = fixture(NVDAX);
  const tlvStart = 166; // 165-byte base + account type
  const data = Buffer.from(info.data);
  // Walk the TLV to flip the pausable flag and set a hook program.
  for (let offset = tlvStart; offset + 4 <= data.length; ) {
    const type = data.readUInt16LE(offset), length = data.readUInt16LE(offset + 2);
    if (type === 0 && length === 0) break;
    if (type === 26) data[offset + 4 + 32] = 1;
    if (type === 14) Keypair.generate().publicKey.toBuffer().copy(data, offset + 4 + 32);
    offset += 4 + length;
  }
  const paused = issuerState(unpackMint(address, { ...info, data }, TOKEN_2022_PROGRAM_ID).tlvData);
  expect(paused.paused).toBe(true);
  expect(paused.transferHookProgram).not.toBeNull();
  expect(() => decodeSupportedMint(address, { ...info, data })).toThrow("transfer hook");
});

const keys = () => Keypair.generate().publicKey;
function order(overrides: Partial<OrderWire> = {}): OrderWire {
  return {
    maker: keys().toBase58(),
    recipient: "",
    marketId: "",
    salt: orderSalt(1n, crypto.getRandomValues(new Uint8Array(32))),
    quantity: "100",
    limitPriceRawX18: String(WAD),
    expiry: "9999",
    nonce: "1",
    maxFeeBps: 1000,
    branch: 0,
    side: 0,
    fundingKind: 0,
    tif: 0,
    bases: 0b111,
    ...overrides,
  };
}

test("order wire: buys accept a leg mask, sells deliver exactly one listed leg", () => {
  const market = keys().toBase58(), maker = keys().toBase58();
  const base = { marketId: market, maker, recipient: maker };
  for (const bases of [1, 2, 4, 3, 7]) expect(parseOrder(order({ ...base, bases })).bases).toBe(bases);
  for (const bases of [0, 8, -1, 1.5]) expect(() => parseOrder(order({ ...base, bases }))).toThrow("base-leg");
  for (const bases of [1, 2, 4]) expect(orderCollateral(parseOrder(order({ ...base, side: 1, bases })))).toBe(singleBase(bases)!);
  for (const bases of [3, 5, 7]) expect(() => parseOrder(order({ ...base, side: 1, bases }))).toThrow("base-leg");
  expect(fundingAsset(order({ ...base, side: 0, fundingKind: 0 }))).toBe(0);
  expect(fundingAsset(order({ ...base, side: 0, fundingKind: 1, branch: 1 }))).toBe(2);
  expect(fundingAsset(order({ ...base, side: 1, bases: 2, fundingKind: 0 }))).toBe(6);
  expect(fundingAsset(order({ ...base, side: 1, bases: 4, fundingKind: 1, branch: 1 }))).toBe(11);
  expect(acceptsLeg({ bases: 0b101 }, 1)).toBe(true);
  expect(acceptsLeg({ bases: 0b101 }, 2)).toBe(false);
  // Terms round-trip through the IDL coder with the new `bases` field.
  const encoded = coder.types.encode("OrderTerms", {
    recipient: keys(), salt: Array(32).fill(1), quantity: bn(1), price: bn(1), expiry: bn(1), nonce: bn(1),
    max_fee_bps: 0, branch: 0, side: 1, funding: 0, tif: 0, bases: 4,
  });
  expect(encoded.at(-1)).toBe(4);
});

function book(input: { taker: Partial<OrderWire>; asks: { bases: number; price: bigint; quantity: bigint; reserved?: bigint; funding?: number }[] }) {
  const market = keys().toBase58();
  const taker = order({ marketId: market, ...input.taker });
  taker.recipient = taker.maker;
  const candidates: Candidate[] = input.asks.map((a, i) => {
    const maker = keys().toBase58();
    const o = order({
      marketId: market, maker, recipient: maker, side: 1 - taker.side, bases: a.bases,
      limitPriceRawX18: String(a.price), quantity: String(a.quantity), fundingKind: a.funding ?? 0,
    });
    return { order: o, orderHash: orderId(o), remaining: a.quantity, sequence: BigInt(i), ...(a.reserved === undefined ? {} : { reserved: a.reserved }) };
  });
  return { market, taker, candidates };
}

test("planner: a bid fills asks of every accepted, tradable leg in price-time order", () => {
  const { taker, candidates } = book({
    taker: { side: 0, bases: 0b011, quantity: "300", limitPriceRawX18: String(2n * WAD) },
    asks: [
      { bases: 0b001, price: 2n * WAD, quantity: 100n },
      { bases: 0b010, price: WAD, quantity: 100n },
      { bases: 0b100, price: WAD / 2n, quantity: 100n }, // leg 3 not accepted
      { bases: 0b010, price: 3n * WAD, quantity: 100n }, // does not cross
    ],
  });
  const plan = planOrder({ order: taker, candidates, now: 1n, step: 1n, nextSequence: 4n, makerFeeBps: 0, takerFeeBps: 0 });
  expect(plan.makers.map((m) => m.bases)).toEqual([0b010, 0b001]);
  expect(plan.filledQuantity).toBe("200");
  expect(plan.executionQuote).toBe(String(100n + 200n));
  parseAtomicPlan(plan, taker);
  // An API-supplied plan cannot smuggle in an unaccepted leg.
  expect(() => parseAtomicPlan({ ...plan, makers: [candidates[2]!.order, ...plan.makers.slice(1)] }, taker)).toThrow("maker leg");
  // Halted legs never fill.
  const legs = { 1: { scale: 1n, multiplier: UNIT_MULTIPLIER, tradable: false }, 2: { scale: 1n, multiplier: UNIT_MULTIPLIER, tradable: true } };
  const halted = planOrder({ order: taker, candidates, now: 1n, step: 1n, nextSequence: 4n, makerFeeBps: 0, takerFeeBps: 0, legs });
  expect(halted.makers.map((m) => m.bases)).toEqual([0b010]);
});

test("planner: a sell fills only bids accepting its leg; a halted leg cannot be offered", () => {
  const { taker, candidates } = book({
    taker: { side: 1, bases: 0b010, quantity: "300", limitPriceRawX18: String(WAD) },
    asks: [
      { bases: 0b001, price: 3n * WAD, quantity: 100n }, // bid refuses leg 2
      { bases: 0b110, price: 2n * WAD, quantity: 100n },
      { bases: 0b111, price: WAD, quantity: 100n },
    ],
  });
  const plan = planOrder({ order: taker, candidates, now: 1n, step: 1n, nextSequence: 3n, makerFeeBps: 0, takerFeeBps: 0 });
  expect(plan.makers.map((m) => m.bases)).toEqual([0b110, 0b111]);
  const legs = { 2: { scale: 1n, multiplier: UNIT_MULTIPLIER, tradable: false } };
  expect(() => planOrder({ order: taker, candidates, now: 1n, step: 1n, nextSequence: 3n, makerFeeBps: 0, takerFeeBps: 0, legs })).toThrow("halted");
});

test("planner: live-multiplier reserve checks skip uncovered asks and mark completing surplus refunds", () => {
  const multiplier = multiplierBits(1.001701196801074);
  const { taker, candidates } = book({
    taker: { side: 0, bases: 0b001, quantity: "300", limitPriceRawX18: String(WAD) },
    asks: [
      // Reserved at 1.0 then the multiplier rose: 100 share units need 9983 raw < 10000 reserved.
      { bases: 1, price: WAD, quantity: 100n, reserved: 10_000n },
      // Reserve below the live conversion (multiplier fell): skipped.
      { bases: 1, price: WAD, quantity: 100n, reserved: 9_000n },
      // Exact reservation: no surplus.
      { bases: 1, price: WAD, quantity: 100n, reserved: baseRaw(100n, 100n, multiplier) },
    ],
  });
  const legs = { 1: { scale: 100n, multiplier, tradable: true } };
  const plan = planOrder({ order: taker, candidates, now: 1n, step: 1n, nextSequence: 3n, makerFeeBps: 0, takerFeeBps: 0, legs });
  expect(plan.makers.map((m) => m.maker)).toEqual([candidates[0]!.order.maker, candidates[2]!.order.maker]);
  expect(plan.surplus).toEqual([true, false]);
});

test("placement: touched legs, 7-account leg blocks, writable minting claims and exact credit frames", () => {
  const program = keys();
  const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:8899", genesisHash: "test", config: keys().toBase58(), programId: program.toBase58() });
  const marketKey = keys();
  const m = marketAccount({ config: client.config, market: marketKey, program, legs: 3, decimals: [6, 8, 9, 9], scales: [100n, 1000n, 1000n] });
  client.rememberMarket(marketKey, m);
  const market = marketKey.toBase58();
  const taker = order({ marketId: market, side: 0, bases: 0b111, quantity: "300", fundingKind: 1 });
  taker.recipient = taker.maker;
  const asks = [0b001, 0b100].map((bases, i) => {
    const maker = keys().toBase58();
    return order({ marketId: market, maker, recipient: maker, side: 1, bases, fundingKind: i === 0 ? 0 : 1 });
  });
  const plan = planOrder({
    order: taker, now: 1n, step: 1n, nextSequence: 2n, makerFeeBps: 0, takerFeeBps: 0, program,
    candidates: asks.map((o, i) => ({ order: o, orderHash: orderId(o, program), remaining: 100n, sequence: BigInt(i) })),
  });
  const ix = client.placement(taker, plan);
  const decoded = coder.instruction.decode(ix.data)!.data as { touched: number };
  expect(decoded.touched).toBe(0b101);
  const k = ix.keys;
  // Quote claims readonly: the buyer funds from claims (no quote minting).
  expect(k.slice(10, 14).map((a) => a.pubkey.toBase58())).toEqual(
    [claimAddress(marketKey, 1, program), vaultAddress(marketKey, 1, program), claimAddress(marketKey, 2, program), vaultAddress(marketKey, 2, program)].map(String),
  );
  expect(k.slice(10, 14).every((a) => !a.isWritable)).toBe(true);
  for (const [block, collateral, minting] of [[0, 1, true], [1, 3, false]] as const) {
    const start = 14 + LEG_ACCOUNTS * block;
    const pool = poolAddress(client.config, m.mints[underlyingAsset(collateral)]!, program);
    expect(k[start]!.pubkey.equals(pool)).toBe(true);
    expect(k[start + 1]!.pubkey.equals(poolVaultAddress(pool, program))).toBe(true);
    expect(k[start + 2]!.pubkey.equals(m.mints[underlyingAsset(collateral)]!)).toBe(true);
    expect(k.slice(start, start + 3).every((a) => !a.isWritable)).toBe(true);
    expect(k[start + 3]!.pubkey.equals(claimAddress(marketKey, claimAsset(collateral, 0), program))).toBe(true);
    expect(k[start + 6]!.pubkey.equals(vaultAddress(marketKey, claimAsset(collateral, 1), program))).toBe(true);
    expect(k.slice(start + 3, start + 7).every((a) => a.isWritable === minting)).toBe(true);
  }
  const makersAt = 14 + 2 * LEG_ACCOUNTS;
  expect(k.slice(makersAt, makersAt + 2).map((a) => a.pubkey.toBase58())).toEqual(asks.map((a) => orderId(a, program)));
  // Participants: taker + two makers, then exactly one frame: the completing
  // underlying-funded ask (surplus unknown without leg state).
  const frames = k.slice(makersAt + 2 + 2 * 3);
  const leg1Pool = poolAddress(client.config, m.mints[3]!, program);
  expect(frames.map((a) => a.pubkey.toBase58())).toEqual([assetCreditAddress(leg1Pool, new PublicKey(asks[0]!.maker), program).toBase58()]);
  // With leg state the planner proves no surplus: no frame.
  const exact = planOrder({
    order: taker, now: 1n, step: 1n, nextSequence: 2n, makerFeeBps: 0, takerFeeBps: 0, program,
    legs: { 1: { scale: 1n, multiplier: UNIT_MULTIPLIER, tradable: true }, 3: { scale: 1n, multiplier: UNIT_MULTIPLIER, tradable: true } },
    candidates: asks.map((o, i) => ({ order: o, orderHash: orderId(o, program), remaining: 100n, reserved: 100n, sequence: BigInt(i) })),
  });
  expect(client.placement(taker, exact).keys.length).toBe(k.length - 1);
  expect(computeUnits([ix], program)).toBeGreaterThan(computeUnits([client.placement(taker, exact)], program));
  // A resting sell touches its own leg even without fills.
  const sell = order({ marketId: market, side: 1, bases: 0b010, fundingKind: 0 });
  sell.recipient = sell.maker;
  const rest = client.placement(sell, planOrder({ order: sell, candidates: [], now: 1n, step: 1n, nextSequence: 0n, makerFeeBps: 0, takerFeeBps: 0 }));
  expect((coder.instruction.decode(rest.data)!.data as { touched: number }).touched).toBe(0b010);
  expect(rest.keys.slice(14, 21).every((a) => !a.isWritable)).toBe(true);
  expect(rest.keys.at(-1)!.pubkey.equals(assetCreditAddress(poolAddress(client.config, m.mints[6]!, program), new PublicKey(sell.maker), program))).toBe(true);
});

test("live leg state mirrors the program's tradable checks for real issuer mints", async () => {
  const { legStates, legAccounts } = await import("../src/index");
  const { ACCOUNT_SIZE, AccountLayout, AccountState: TokenAccountState } = await import("@solana/spl-token");
  const program = keys(), config = keys(), marketKey = keys();
  const mints = [NVDAX, NVDAON, NVDAR].map((a) => fixture(a));
  const m = marketAccount({ config, market: marketKey, program, legs: 3, baseMints: mints.map((f) => f.address), decimals: [6, 8, 9, 9], scales: [100n, 1000n, 1000n] });
  // Listing multipliers as of listing; NVDAx later moved within the dividend band.
  m.legs[0]!.multiplier = bn(multiplierBits(1.0009180758490996));
  m.legs[1]!.multiplier = bn(multiplierBits(1.0017152487959897));
  m.legs[2]!.multiplier = bn(multiplierBits(0.5)); // e.g. listed before a 2:1 split: out of band now
  const vault = (state: number) => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode({ mint: PublicKey.default, owner: PublicKey.default, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
      state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
  };
  const accounts = legAccounts(m, config, program);
  expect(accounts).toHaveLength(6);
  const infos = [...mints.map((f) => f.info), vault(TokenAccountState.Initialized), vault(TokenAccountState.Frozen), vault(TokenAccountState.Initialized)];
  const legs = legStates(m, infos, config, program, 1_790_000_000n);
  expect(legs[1]!.tradable).toBe(true);
  expect(legs[1]!.multiplierValue).toBe(1.001701196801074);
  expect(legs[2]!.halt).toBe("vault-frozen");
  expect(legs[3]!.halt).toBe("corporate-action");
  m.legs[0]!.active = false;
  expect(legStates(m, infos, config, program, 1_790_000_000n)[1]!.halt).toBe("delisted");
  expect(legStates(m, [null, ...infos.slice(1)], config, program)[1]!.halt).toBe("unreadable");
});

// Shared with crates/protocol-core/tests/multiplier.rs (independently computed with exact rationals).
const GOLDEN: [string, string, string, string, string][] = [
  ["1000000", "100", "0x3FF0000000000000", "100000000", "100000000"],
  ["1000000", "100", "0x3FF006F7D589FEA9", "99830169", "99830170"],
  ["1000000", "100", "0x3FF003C2AC1BF43F", "99908276", "99908277"],
  ["1000000", "1000", "0x3FF007069197BB83", "998287688", "998287689"],
  ["1000000", "1000", "0x3FF0000000000000", "1000000000", "1000000000"],
  ["1", "100", "0x3FF006F7D589FEA9", "99", "100"],
  ["123456789", "1000", "0x3FF026CD3C9CCD2C", "122298248787", "122298248788"],
  ["1", "1", "0x3FF003C2AC1BF43F", "0", "1"],
  ["1", "1000", "0x3FF00AE99FC77550", "997", "998"],
  ["250000000", "100", "0x3FF00DD411E4D9A3", "24915882144", "24915882145"],
  ["18446744073709551", "1000", "0x3FF4000000000000", "14757395258967640800", "14757395258967640800"],
  ["7", "1", "0x3F40000000000000", "14336", "14336"],
  ["3", "1", "0x4008000000000000", "1", "1"],
  ["4", "1", "0x4008000000000000", "1", "2"],
  ["1000000", "100", "0x3FF33B8FCD0BFE64", "83191807", "83191808"],
  ["999999", "1000", "0x3FE999999999999A", "1249998749", "1249998750"],
  ["18446744073709551615", "1", "0x433FFFFFFFFFFFFF", "2048", "2049"],
  ["5", "100000000000000000", "0x3FF017682698A5D0", "497158955178779784", "497158955178779785"],
];
test("baseRaw matches the Rust golden vectors exactly", () => {
  for (const [units, scale, bits, down, up] of GOLDEN) {
    expect(baseRaw(BigInt(units), BigInt(scale), BigInt(bits))).toBe(BigInt(down));
    expect(baseRaw(BigInt(units), BigInt(scale), BigInt(bits), true)).toBe(BigInt(up));
  }
});
