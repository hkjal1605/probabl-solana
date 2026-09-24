/** Multi-issuer markets end to end on the compiled program with real
 * Token-2022 CPIs: mock issuer mints replicate the mainnet xStocks, Ondo,
 * Remora and Backpack extension sets (scripts/solana/mock-issuers.ts), and the
 * harness admin plays the issuer authority (pause, multiplier, freeze). */
import { beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createFreezeAccountInstruction,
  createThawAccountInstruction,
  getAccount,
  getMint,
  TOKEN_2022_PROGRAM_ID as T22,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  baseRaw,
  big,
  bn,
  claimAddress,
  claimAsset,
  coder,
  digest,
  key,
  legBit,
  multiplierBits,
  orderId,
  planOrder,
  poolAddress,
  poolVaultAddress,
  quote as quoteOf,
  resolutionHash,
  underlyingAsset,
  unwrap,
  walletAddress,
  type AssetPoolAccount,
  type OrderWire,
} from "../src/index.ts";
import {
  addBaseInstructions,
  addBaseTransaction,
  initializeMarketVaults,
  mintAdmission,
  setBaseTransaction,
} from "../src/admin.ts";
import {
  ISSUERS,
  pauseIssuer,
  resumeIssuer,
  updateIssuerMultiplier,
  type IssuerProfile,
} from "../../../scripts/solana/mock-issuers.ts";
import { now, ValidatorHarness } from "./validator-harness.ts";

const WAD = 10n ** 18n;
const rpc = process.env.SOLANA_TEST_RPC;
describe.skipIf(!rpc)("multi-issuer markets on the compiled program (real Token-2022 CPIs)", () => {
  const h = new ValidatorHarness(rpc ?? "http://127.0.0.1:8899");
  const alice = Keypair.generate(),
    bob = Keypair.generate(),
    carol = Keypair.generate(),
    guardian = Keypair.generate(),
    attacker = Keypair.generate();
  const owners = [h.admin, alice, bob, carol, guardian, attacker].map((k) => k.publicKey);
  const markets: PublicKey[] = [];
  const mints: PublicKey[] = [];
  let quote: PublicKey;

  const pool = (mint: PublicKey) => poolAddress(h.client.config, mint, h.client.program);
  const poolVault = (mint: PublicKey) => poolVaultAddress(pool(mint), h.client.program);
  const poolState = (mint: PublicKey) => h.client.fetch<AssetPoolAccount>("AssetPool", pool(mint));
  async function events(signature: string) {
    const tx = await h.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return (tx?.meta?.logMessages ?? [])
      .filter((line) => line.startsWith("Program data: "))
      .map((line) => coder.events.decode(line.slice("Program data: ".length)))
      .filter((e): e is NonNullable<typeof e> => e !== null);
  }
  const deposit = (owner: Keypair, mint: PublicKey, amount: bigint, program = T22) =>
    h.send([h.client.depositPool(owner.publicKey, mint, amount, program)], owner);

  /** Per mint: vault >= liability == Σ credits + Σ markets (escrow + backing);
   * per market collateral: claim supply is fully backed. */
  async function conserve() {
    for (const mint of [quote, ...mints]) {
      if (!(await h.connection.getAccountInfo(pool(mint), "confirmed"))) continue;
      const state = await poolState(mint);
      let owed = 0n;
      for (const owner of owners) owed += await h.credit(mint, owner);
      for (const m of markets) {
        const market = await h.client.market(m);
        for (let c = 0; c <= market.bases; c++)
          if (market.mints[underlyingAsset(c)]!.equals(mint)) {
            expect(big(market.credits[underlyingAsset(c)]!)).toBe(0n);
            owed += big(market.escrow[underlyingAsset(c)]!) + big(market.backing[c]!);
          }
      }
      expect(big(state.liability)).toBe(owed);
      const vault = await getAccount(h.connection, poolVault(mint), "confirmed", state.token_program);
      expect(vault.amount >= owed).toBe(true);
    }
    for (const m of markets) {
      const market = await h.client.market(m);
      for (let c = 0; c <= market.bases; c++) {
        const bits = (1 << claimAsset(c, 0)) | (1 << claimAsset(c, 1));
        if ((market.vaults_initialized & bits) !== bits) continue;
        const [yes, no] = await Promise.all(
          [0, 1].map(
            async (b) => (await getMint(h.connection, claimAddress(m, claimAsset(c, b), h.client.program), "confirmed")).supply,
          ),
        );
        let required = yes! > no! ? yes! : no!;
        if ([6, 7].includes(market.state)) {
          const y = BigInt(market.payouts[0]!),
            n = BigInt(market.payouts[1]!);
          required = (yes! * y + no! * n + y + n - 1n) / (y + n);
        }
        expect(big(market.backing[c]!) >= required).toBe(true);
      }
    }
  }

  /** Fresh issuer mints listed as legs 1..n of a new open market; alice holds
   * and deposits every leg, bob holds quote; wallets and a lookup table. */
  async function setup(profiles: IssuerProfile[], ticker = "NVDA") {
    const legs: PublicKey[] = [];
    for (const profile of profiles) {
      const issuer = await h.issuerMint(profile, ticker);
      legs.push(issuer.mint);
      mints.push(issuer.mint);
      await h.fund(issuer.mint, alice.publicKey, 10n ** 13n);
    }
    const market = await h.market(legs);
    markets.push(market);
    for (const mint of legs) await deposit(alice, mint, 10n ** 12n);
    for (const owner of [alice, bob, carol])
      await h.send([h.client.initializeWallet(market, owner.publicKey, h.admin.publicKey)]);
    // One table per market keeps each well under the 256-address limit.
    h.tables = [];
    await h.lookupMarket(market, [alice.publicKey, bob.publicKey, carol.publicKey]);
    return { market, legs };
  }
  const ask = (market: PublicKey, collateral: number, quantity = 1000n, price = WAD, owner = alice) =>
    h.order(market, owner, {
      side: 1,
      bases: legBit(collateral),
      quantity: String(quantity),
      limitPriceRawX18: String(price),
    });
  const bid = (market: PublicKey, bases: number, quantity = 1000n, price = WAD, tif = 1) =>
    h.order(market, bob, {
      side: 0,
      bases,
      quantity: String(quantity),
      limitPriceRawX18: String(price),
      tif,
    });
  const split = (market: PublicKey, owner: Keypair, collateral: number, amount: bigint) =>
    h.send(
      [
        h.client.positionCredit(market, owner.publicKey, collateral),
        h.client.position("split", market, owner.publicKey, collateral, amount),
      ],
      owner,
    );
  /** Plans without live leg state and without reservations: what a stale or
   * malicious planner would submit. The program must still reject it. */
  async function forced(o: OrderWire, owner: Keypair, makers: OrderWire[]) {
    const { market } = await h.legs(key(o.marketId));
    const config = await h.client.configAccount();
    const candidates = (await h.candidates(makers)).map(({ reserved: _reserved, ...c }) => c);
    const plan = planOrder({
      order: o,
      candidates,
      now: BigInt(now()),
      step: big(market.terms.step),
      nextSequence: big(market.sequence[o.branch]!),
      makerFeeBps: config.maker_bps,
      takerFeeBps: config.taker_bps,
      program: h.client.program,
    });
    return h.send([h.client.placement(o, plan, market)], owner);
  }
  const orderState = (o: OrderWire) => h.client.order(key(orderId(o, h.client.program)));

  beforeAll(async () => {
    await h.airdrop(h.admin.publicKey, alice.publicKey, bob.publicKey, carol.publicKey, guardian.publicKey, attacker.publicKey);
    quote = await h.plainMint(6, TOKEN_PROGRAM_ID);
    await h.initialize(quote);
    await h.fund(quote, bob.publicKey, 10n ** 13n);
    await deposit(bob, quote, 10n ** 12n, TOKEN_PROGRAM_ID);
  }, 120_000);

  test("pools admit exactly each issuer's controls; wrong, extra and generic masks are rejected", async () => {
    const profiles: [IssuerProfile, string][] = [
      ["xstocks", "NVDA"],
      ["ondo", "NVDA"],
      ["remora", "NVDA"],
      ["backpack", "SPCX"],
    ];
    for (const [profile, ticker] of profiles) {
      const spec = ISSUERS[profile];
      const { mint } = await h.issuerMint(profile, ticker);
      mints.push(mint);
      const admission = await mintAdmission(h.client, mint);
      expect(admission.admitted).toBe(spec.admitted);
      expect(admission.decimals).toBe(spec.decimals);
      expect(admission.program.equals(T22)).toBe(true);
      expect(admission.issuer.multiplier).toBe(multiplierBits(spec.multiplier));
      const missing = spec.admitted & (spec.admitted - 1);
      const extra = spec.admitted === 63 ? 64 | 63 : 63;
      for (const wrong of [missing, extra, 0])
        await h.rejects(
          h.send([h.client.initializePool(mint, h.admin.publicKey, T22, wrong)]),
          "UnsupportedTokenExtension",
        );
      // Admission is a listing decision of the market administrator.
      await h.rejects(
        h.send([h.client.initializePool(mint, attacker.publicKey, T22, spec.admitted)], attacker),
        "Unauthorized",
      );
      expect(await h.connection.getAccountInfo(pool(mint))).toBeNull();
      expect(await h.connection.getAccountInfo(poolVault(mint))).toBeNull();
      await h.send([h.client.initializePool(mint, h.admin.publicKey, T22, spec.admitted)]);
      const state = await poolState(mint);
      expect(state.admitted).toBe(spec.admitted);
      expect(state.decimals).toBe(spec.decimals);
      expect(state.token_program.equals(T22)).toBe(true);
      expect(big(state.liability)).toBe(0n);
      const vault = await getAccount(h.connection, poolVault(mint), "confirmed", T22);
      expect(vault.isFrozen).toBe(false);
      expect(vault.owner.equals(pool(mint))).toBe(true);
    }
    await conserve();
  }, 180_000);

  test("issuer-token deposits and withdrawals move exact raw amounts through protocol-wide pools", async () => {
    for (const profile of ["xstocks", "ondo", "remora", "backpack"] as const) {
      const { mint } = await h.issuerMint(profile, profile === "backpack" ? "SPCX" : "NVDA");
      mints.push(mint);
      await h.send([h.client.initializePool(mint, h.admin.publicKey, T22, ISSUERS[profile].admitted)]);
      await h.fund(mint, carol.publicKey, 5_000_000_000n);
      const external = await h.tokenBalance(mint, carol.publicKey);
      await h.send([h.client.deposit(PublicKey.default, carol.publicKey, mint, underlyingAsset(1), 1_234_567n, T22)], carol);
      expect(await h.credit(mint, carol.publicKey)).toBe(1_234_567n);
      expect(big((await poolState(mint)).liability)).toBe(1_234_567n);
      expect(await h.tokenBalance(mint, carol.publicKey)).toBe(external - 1_234_567n);
      const quoted = await h.client.depositForCredit(PublicKey.default, carol.publicKey, mint, underlyingAsset(2), 1_000n);
      expect(quoted.gross).toBe(1_000n);
      await h.send([quoted.instruction], carol);
      await h.rejects(
        h.send(h.client.withdrawPool(carol.publicKey, mint, 1_235_568n, carol.publicKey, T22), carol),
        "InsufficientFunds",
      );
      await h.send(
        h.client.withdraw(PublicKey.default, carol.publicKey, mint, underlyingAsset(1), 235_567n, carol.publicKey, T22),
        carol,
      );
      expect(await h.credit(mint, carol.publicKey)).toBe(1_000_000n);
      expect(big((await poolState(mint)).liability)).toBe(1_000_000n);
      expect(await h.tokenBalance(mint, carol.publicKey)).toBe(external - 1_000_000n);
      expect((await getAccount(h.connection, poolVault(mint), "confirmed", T22)).amount).toBe(1_000_000n);
    }
    await conserve();
  }, 180_000);

  test("add_base lists three issuers with different decimals; a fourth, duplicates and early opening are rejected", async () => {
    const issuers = [];
    for (const profile of ["xstocks", "ondo", "remora"] as const) issuers.push(await h.issuerMint(profile));
    const fourth = await h.issuerMint("backpack", "NVDA");
    mints.push(...issuers.map((i) => i.mint), fourth.mint);
    const market = await h.market([], {}, { open: false });
    markets.push(market);
    // Quote only: no active leg, so the market cannot open.
    await h.rejects(h.open(market), "InvalidState");
    const addBase = (mint: PublicKey, program = T22) =>
      h.client.ix(
        "add_base",
        {},
        {
          admin: h.admin.publicKey,
          config: h.client.config,
          market,
          mint,
          pool: pool(mint),
          vault: poolVault(mint),
          token_program: program,
        },
      );
    for (const [index, issuer] of issuers.entries()) {
      const signature = await h.send(await addBaseInstructions(h.client, market, h.admin.publicKey, issuer.mint));
      const change = (await events(signature)).find((e) => e.name === "Change");
      expect(change?.data.kind).toBe(15);
      expect(change?.data.asset).toBe(index + 1);
      expect(big(change?.data.amount as never)).toBe(index === 0 ? 100n : 1000n);
      if (index === 0) {
        // Duplicate issuer mint, and the quote mint itself, are rejected.
        await h.rejects(h.send([addBase(issuer.mint)]), "InvalidAsset");
        await h.rejects(h.send([addBase(quote, TOKEN_PROGRAM_ID)]), "InvalidAsset");
      }
    }
    const listed = await h.client.market(market);
    expect(listed.bases).toBe(3);
    expect(listed.decimals).toEqual([6, 8, 9, 9]);
    expect(listed.legs.map((l) => big(l.scale))).toEqual([100n, 1000n, 1000n]);
    for (const [index, issuer] of issuers.entries()) {
      expect(listed.mints[underlyingAsset(index + 1)]!.equals(issuer.mint)).toBe(true);
      expect(big(listed.legs[index]!.multiplier)).toBe((await mintAdmission(h.client, issuer.mint)).issuer.multiplier);
      expect(big(listed.legs[index]!.multiplier)).toBe(multiplierBits(ISSUERS[issuer.profile].multiplier));
      expect(listed.legs[index]!.active).toBe(true);
    }
    // Legs are listed but their claim mints are not: still not openable.
    await h.rejects(h.open(market), "InvalidState");
    await expect(
      addBaseTransaction(h.client, market.toBase58(), h.admin.publicKey.toBase58(), fourth.mint.toBase58()),
    ).rejects.toThrow("at most 3");
    await h.send([h.client.initializePool(fourth.mint, h.admin.publicKey, T22, 63)]);
    await h.rejects(h.send([addBase(fourth.mint)]), "InvalidAsset");
    const claims = await initializeMarketVaults(
      h.client,
      market.toBase58(),
      h.admin.publicKey.toBase58(),
      issuers.map((i) => i.mint.toBase58()),
    );
    expect(claims).toHaveLength(3);
    for (const tx of claims) await h.send(unwrap(tx, h.client.program));
    await h.open(market);
    expect((await h.client.market(market)).state).toBe(2);
    const { legs } = await h.legs(market);
    expect(Object.values(legs).map((l) => [l.decimals, l.scale, l.tradable])).toEqual([
      [8, 100n, true],
      [9, 1000n, true],
      [9, 1000n, true],
    ]);
    await conserve();
  }, 180_000);

  test("one bid accepting two legs fills asks of two issuers with live conversion, fees and surplus refunds", async () => {
    const { market, legs: mintsOf } = await setup(["xstocks", "ondo", "remora"]);
    await h.configure(10, 20);
    try {
      const { legs } = await h.legs(market);
      const a1 = ask(market, 1, 1000n, WAD),
        a2 = ask(market, 2, 1000n, (3n * WAD) / 2n);
      const credits = async () => [await h.credit(mintsOf[0]!, alice.publicKey), await h.credit(mintsOf[1]!, alice.publicKey)];
      const creditsBefore = await credits();
      await h.place(a1, alice);
      await h.place(a2, alice);
      const reserved = [big((await orderState(a1)).reserved), big((await orderState(a2)).reserved)];
      expect(reserved).toEqual([
        baseRaw(1000n, 100n, legs[1]!.multiplier, true),
        baseRaw(1000n, 1000n, legs[2]!.multiplier, true),
      ]);
      expect(await credits()).toEqual([creditsBefore[0]! - reserved[0]!, creditsBefore[1]! - reserved[1]!]);
      const quoteBefore = await h.credit(quote, bob.publicKey);
      const buyerBefore = await h.balances(market, bob.publicKey);
      const b = bid(market, legBit(1) | legBit(2), 2000n, 2n * WAD, 0);
      const { plan } = await h.plan(b, [a1, a2]);
      expect(plan.makers.map((m) => m.bases)).toEqual([legBit(1), legBit(2)]);
      const raw = [
        baseRaw(1000n, 100n, legs[1]!.multiplier, false),
        baseRaw(1000n, 1000n, legs[2]!.multiplier, false),
      ];
      expect(plan.surplus).toEqual([reserved[0]! > raw[0]!, reserved[1]! > raw[1]!]);
      const signature = await h.send([h.client.placement(b, plan, await h.client.market(market))], bob);
      const trades = (await events(signature)).filter((e) => e.name === "Trade");
      expect(
        trades.map((t) => [t.data.base, big(t.data.base_amount as never), big(t.data.quantity as never)]),
      ).toEqual([
        [1, raw[0], 1000n],
        [2, raw[1], 1000n],
      ]);
      // Buyer fee (taker 20 bps) on raw base claims, carried across fills of one order.
      const fee1 = (raw[0]! * 20n) / 10_000n,
        carry = (raw[0]! * 20n) % 10_000n,
        fee2 = (raw[1]! * 20n + carry) / 10_000n;
      const buyer = await h.balances(market, bob.publicKey);
      expect(buyer[claimAsset(1, 0)]! - buyerBefore[claimAsset(1, 0)]!).toBe(raw[0]! - fee1);
      expect(buyer[claimAsset(2, 0)]! - buyerBefore[claimAsset(2, 0)]!).toBe(raw[1]! - fee2);
      const paid = quoteOf(1000n, WAD) + quoteOf(1000n, (3n * WAD) / 2n);
      expect(buyer[claimAsset(0, 1)]! - buyerBefore[claimAsset(0, 1)]!).toBe(paid);
      // Price improvement returns to the buyer's quote pool credit.
      expect(await h.credit(quote, bob.publicKey)).toBe(quoteBefore - paid);
      // Seller fee (maker 10 bps) on quote; the seller's own leg NO claim.
      const seller = await h.balances(market, alice.publicKey);
      const sellerFees = (1000n * 10n) / 10_000n + (1500n * 10n) / 10_000n;
      expect(seller[claimAsset(0, 0)]).toBe(paid - sellerFees);
      expect(seller[claimAsset(1, 1)]).toBe(raw[0]);
      expect(seller[claimAsset(2, 1)]).toBe(raw[1]);
      // Completed asks refunded their round-down reservation surplus.
      expect(await credits()).toEqual([creditsBefore[0]! - raw[0]!, creditsBefore[1]! - raw[1]!]);
      for (const o of [a1, a2, b]) {
        const state = await orderState(o);
        expect(state.status).toBe(2);
        expect(big(state.reserved)).toBe(0n);
      }
      const after = await h.client.market(market);
      const fees = after.fees.map(big);
      expect([fees[claimAsset(0, 0)], fees[claimAsset(1, 0)], fees[claimAsset(2, 0)]]).toEqual([sellerFees, fee1, fee2]);
      expect(after.backing.map(big)).toEqual([paid, raw[0]!, raw[1]!, 0n]);
      await conserve();
    } finally {
      await h.configure(0, 0);
    }
  }, 240_000);

  test("asks match resting bids only when the bid accepts their leg", async () => {
    const { market } = await setup(["xstocks", "ondo"]);
    const only1 = bid(market, legBit(1), 1000n, WAD, 0);
    await h.place(only1, bob);
    const leg2 = ask(market, 2);
    const plan = await h.place(leg2, alice, [only1]);
    expect(plan.makers).toHaveLength(0);
    expect(big((await orderState(only1)).remaining)).toBe(1000n);
    expect(big((await orderState(leg2)).remaining)).toBe(1000n);
    // A planner that ignores leg acceptance is rejected by the program.
    const watched = [market, key(orderId(only1, h.client.program))];
    const before = await h.snapshot(watched);
    const lie = { ...only1, bases: legBit(1) | legBit(2) };
    await h.rejects(forced(ask(market, 2), alice, [lie]), "StalePlan", watched, before);
    // A leg-1 ask fills it.
    expect((await h.place(ask(market, 1), alice, [only1])).makers).toHaveLength(1);
    expect((await orderState(only1)).status).toBe(2);
    // A resting bid accepting both legs takes asks of either issuer.
    const both = bid(market, legBit(1) | legBit(2), 1000n, WAD, 0);
    await h.place(both, bob);
    expect((await h.place(ask(market, 1, 500n), alice, [both])).makers).toHaveLength(1);
    expect((await h.place(ask(market, 2, 500n), alice, [both])).makers).toHaveLength(1);
    expect((await orderState(both)).status).toBe(2);
    const buyer = await h.balances(market, bob.publicKey);
    const { legs } = await h.legs(market);
    expect(buyer[claimAsset(1, 0)]).toBe(
      baseRaw(1000n, 100n, legs[1]!.multiplier, false) + baseRaw(500n, 100n, legs[1]!.multiplier, false),
    );
    expect(buyer[claimAsset(2, 0)]).toBe(baseRaw(500n, 1000n, legs[2]!.multiplier, false));
    await h.send([await h.client.cancel(key(orderId(leg2, h.client.program)), alice.publicKey)], alice);
    await conserve();
  }, 240_000);

  test("an issuer pause halts custody and that leg while the other legs keep trading", async () => {
    const {
      market,
      legs: [paused, live],
    } = await setup(["xstocks", "ondo"]);
    const aPaused = ask(market, 1),
      aLive = ask(market, 2);
    await h.place(aPaused, alice);
    await h.place(aLive, alice);
    await split(market, alice, 1, 5_000n);
    await h.send([pauseIssuer(paused!, h.admin.publicKey)]);
    const { legs } = await h.legs(market);
    expect(legs[1]!.halt).toBe("issuer-paused");
    expect(legs[1]!.paused).toBe(true);
    expect(legs[2]!.tradable).toBe(true);
    await h.rejects(deposit(alice, paused!, 10n), "IssuerPaused");
    await h.rejects(
      h.send(h.client.withdrawPool(alice.publicKey, paused!, 10n, alice.publicKey, T22), alice),
      "IssuerPaused",
    );
    await expect(h.client.depositForCredit(market, alice.publicKey, paused!, underlyingAsset(1), 10n)).rejects.toThrow(
      "paused",
    );
    await h.rejects(h.place(ask(market, 1), alice, [], { live: false }), "LegHalted");
    await h.rejects(split(market, alice, 1, 10n), "LegHalted");
    // Merging existing claims never needs the issuer: still recoverable.
    await h.send(
      [h.client.positionCredit(market, alice.publicKey, 1), h.client.position("merge", market, alice.publicKey, 1, 1_000n)],
      alice,
    );
    // Filling the paused leg's resting ask is rejected; the planner skips it.
    const before = await h.snapshot([market]);
    await h.rejects(forced(bid(market, legBit(1) | legBit(2), 2000n), bob, [aPaused, aLive]), "LegHalted", [market], before);
    const plan = await h.place(bid(market, legBit(1) | legBit(2), 2000n), bob, [aPaused, aLive]);
    expect(plan.makers.map((m) => m.bases)).toEqual([legBit(2)]);
    expect((await orderState(aLive)).status).toBe(2);
    expect((await orderState(aPaused)).status).toBe(1);
    // The unpaused leg keeps full custody.
    await deposit(alice, live!, 10n);
    await conserve();
    await h.send([resumeIssuer(paused!, h.admin.publicKey)]);
    expect((await h.legs(market)).legs[1]!.tradable).toBe(true);
    await deposit(alice, paused!, 10n);
    expect((await h.place(bid(market, legBit(1)), bob, [aPaused])).makers).toHaveLength(1);
    expect((await orderState(aPaused)).status).toBe(2);
    await split(market, alice, 1, 10n);
    await conserve();
  }, 240_000);

  test("multiplier updates convert fills in band, halt the leg out of band, and wait for their timestamp", async () => {
    const {
      market,
      legs: [scaled, other],
    } = await setup(["xstocks", "ondo"]);
    const listing = big((await h.client.market(market)).legs[0]!.multiplier);
    // Reserved at the listing multiplier, filled after a dividend (1.05).
    const early = ask(market, 1);
    await h.place(early, alice);
    const earlyReserved = big((await orderState(early)).reserved);
    expect(earlyReserved).toBe(baseRaw(1000n, 100n, listing, true));
    await h.send([updateIssuerMultiplier(scaled!, h.admin.publicKey, 1.05, 0n)]);
    let { legs } = await h.legs(market);
    expect(legs[1]!.multiplier).toBe(multiplierBits(1.05));
    expect(legs[1]!.tradable).toBe(true);
    const creditBefore = await h.credit(scaled!, alice.publicKey);
    const buyerBefore = await h.balances(market, bob.publicKey);
    const plan = await h.place(bid(market, legBit(1)), bob, [early]);
    const raw = baseRaw(1000n, 100n, multiplierBits(1.05), false);
    expect(plan.surplus).toEqual([true]);
    expect((await h.balances(market, bob.publicKey))[claimAsset(1, 0)]! - buyerBefore[claimAsset(1, 0)]!).toBe(raw);
    expect(await h.credit(scaled!, alice.publicKey)).toBe(creditBefore + earlyReserved - raw);
    // Reserved at 1.05; the multiplier then falls back inside the band, so the
    // reservation no longer covers delivery: the planner skips it, the program rejects it.
    const late = ask(market, 1);
    await h.place(late, alice);
    const lateReserved = big((await orderState(late)).reserved);
    expect(lateReserved).toBe(baseRaw(1000n, 100n, multiplierBits(1.05), true));
    await h.send([updateIssuerMultiplier(scaled!, h.admin.publicKey, 1.0, 0n)]);
    ({ legs } = await h.legs(market));
    expect(legs[1]!.tradable).toBe(true);
    expect(baseRaw(1000n, 100n, legs[1]!.multiplier, false) > lateReserved).toBe(true);
    expect((await h.plan(bid(market, legBit(1)), [late])).plan.makers).toHaveLength(0);
    const before = await h.snapshot([market]);
    await h.rejects(forced(bid(market, legBit(1)), bob, [late]), "StalePlan", [market], before);
    await h.send([await h.client.cancel(key(orderId(late, h.client.program)), alice.publicKey)], alice);
    // A scheduled change (even out of band) applies only from its timestamp.
    await h.send([updateIssuerMultiplier(other!, h.admin.publicKey, 3.0, BigInt(now() + 3600))]);
    ({ legs } = await h.legs(market));
    expect(legs[2]!.tradable).toBe(true);
    expect(legs[2]!.multiplier).toBe(multiplierBits(ISSUERS.ondo.multiplier));
    expect(legs[2]!.issuer?.nextMultiplier?.bits).toBe(multiplierBits(3.0));
    // A stock split leaves the band: the leg halts, the other leg trades.
    const resting = ask(market, 1);
    await h.place(resting, alice);
    await h.send([updateIssuerMultiplier(scaled!, h.admin.publicKey, 2.0, 0n)]);
    ({ legs } = await h.legs(market));
    expect(legs[1]!.halt).toBe("corporate-action");
    await h.rejects(h.place(ask(market, 1), alice, [], { live: false }), "LegHalted");
    await h.rejects(split(market, alice, 1, 10n), "LegHalted");
    await h.rejects(forced(bid(market, legBit(1)), bob, [resting]), "LegHalted");
    const onOther = ask(market, 2);
    await h.place(onOther, alice);
    const mixed = await h.place(bid(market, legBit(1) | legBit(2), 2000n), bob, [resting, onOther]);
    expect(mixed.makers.map((m) => m.bases)).toEqual([legBit(2)]);
    expect(big((await orderState(onOther)).filled)).toBe(1000n);
    // Resting asks of a halted leg remain cancellable by their owner.
    await h.send([await h.client.cancel(key(orderId(resting, h.client.program)), alice.publicKey)], alice);
    await conserve();
  }, 240_000);

  test("delisting a leg halts it, makes its asks publicly releasable, and only the admin relists", async () => {
    const {
      market,
      legs: [delisted],
    } = await setup(["xstocks", "remora"]);
    const a1 = ask(market, 1),
      a1b = ask(market, 1),
      a2 = ask(market, 2);
    for (const o of [a1, a1b, a2]) await h.place(o, alice);
    await h.rejects(
      h.send([await h.client.cancel(key(orderId(a1, h.client.program)), carol.publicKey)], carol),
      "Unauthorized",
    );
    const config = await h.client.configAccount();
    const setRoles = (g: PublicKey) =>
      h.send([
        h.client.ix(
          "configure",
          { roles: { ...config.roles, guardian: g }, maker_bps: config.maker_bps, taker_bps: config.taker_bps },
          { admin: h.admin.publicKey, config: h.client.config },
        ),
      ]);
    await setRoles(guardian.publicKey);
    try {
      const setBase = (actor: Keypair, active: boolean) =>
        h.send(
          unwrap(
            setBaseTransaction(h.client.deployment, actor.publicKey.toBase58(), market.toBase58(), 1, active),
            h.client.program,
          ),
          actor,
        );
      await h.rejects(setBase(attacker, false), "Unauthorized");
      const signature = await setBase(guardian, false);
      const change = (await events(signature)).find((e) => e.name === "Change");
      expect([change?.data.kind, change?.data.asset, big(change?.data.amount as never)]).toEqual([16, 1, 0n]);
      await h.rejects(setBase(guardian, false), "InvalidState");
      const { legs } = await h.legs(market);
      expect(legs[1]!.halt).toBe("delisted");
      expect(legs[2]!.tradable).toBe(true);
      // Anyone may release an ask of a delisted leg, only to its owner.
      const credit = await h.credit(delisted!, alice.publicKey);
      const reserved = big((await orderState(a1)).reserved);
      await h.send([await h.client.cancel(key(orderId(a1, h.client.program)), carol.publicKey)], carol);
      expect((await orderState(a1)).status).toBe(3);
      expect(await h.credit(delisted!, alice.publicKey)).toBe(credit + reserved);
      expect(await h.credit(delisted!, carol.publicKey)).toBe(0n);
      await h.rejects(h.place(ask(market, 1), alice, [], { live: false }), "LegHalted");
      await h.rejects(split(market, alice, 1, 10n), "LegHalted");
      await h.rejects(forced(bid(market, legBit(1) | legBit(2), 2000n), bob, [a1b, a2]), "LegHalted");
      const plan = await h.place(bid(market, legBit(1) | legBit(2), 2000n), bob, [a1b, a2]);
      expect(plan.makers.map((m) => m.bases)).toEqual([legBit(2)]);
      await h.rejects(setBase(guardian, true), "Unauthorized");
      await setBase(h.admin, true);
      expect((await h.legs(market)).legs[1]!.tradable).toBe(true);
      expect((await h.place(bid(market, legBit(1)), bob, [a1b])).makers).toHaveLength(1);
      expect((await orderState(a1b)).status).toBe(2);
    } finally {
      await setRoles(h.admin.publicKey);
    }
    await conserve();
  }, 240_000);

  test("split, merge and redeem stay segregated per issuer through YES and INVALID resolution", async () => {
    const {
      market,
      legs: [first, second],
    } = await setup(["xstocks", "ondo"]);
    const liabilities = async () => [big((await poolState(first!)).liability), big((await poolState(second!)).liability)];
    const credits = async () => [await h.credit(first!, alice.publicKey), await h.credit(second!, alice.publicKey)];
    const [c1, c2] = await credits();
    const [l1, l2] = await liabilities();
    await split(market, alice, 1, 5_000n);
    const viaSdk = await h.client.positionTransaction("split", market, alice.publicKey, 2, 7_000n);
    await h.send(unwrap(viaSdk, h.client.program), alice);
    await h.send(
      [h.client.positionCredit(market, bob.publicKey, 0), h.client.position("split", market, bob.publicKey, 0, 3_000n)],
      bob,
    );
    // Each issuer's claims are backed only by that issuer: pool liabilities are
    // unchanged (credit moved to backing), each leg debited only its own credit.
    expect(await credits()).toEqual([c1! - 5_000n, c2! - 7_000n]);
    expect(await liabilities()).toEqual([l1!, l2!]);
    expect((await h.client.market(market)).backing.map(big)).toEqual([3_000n, 5_000n, 7_000n, 0n]);
    await h.send(
      [h.client.positionCredit(market, alice.publicKey, 1), h.client.position("merge", market, alice.publicKey, 1, 1_000n)],
      alice,
    );
    expect(big((await h.client.market(market)).backing[1]!)).toBe(4_000n);
    await conserve();
    // Hand alice's leg-2 NO to carol so alice redeems a single winning side.
    await h.send(
      [
        h.client.ix(
          "transfer_credit",
          { asset: claimAsset(2, 1), amount: bn(7_000) },
          {
            owner: alice.publicKey,
            market,
            source: walletAddress(market, alice.publicKey, h.client.program),
            destination: walletAddress(market, carol.publicKey, h.client.program),
          },
        ),
      ],
      alice,
    );
    const evidence = digest("multi-issuer yes"),
      uri = "ipfs://multi-issuer-yes";
    await h.send([
      h.lifecycle(market, 1, digest("freeze")),
      h.lifecycle(market, 3, resolutionHash(h.client.config, market, 1, 0, evidence, uri, h.client.program)),
      h.client.ix(
        "resolve",
        { yes: 1, no: 0, evidence: [...evidence], uri },
        { actor: h.admin.publicKey, config: h.client.config, market },
      ),
    ]);
    // One resolution covers every leg; each redeems into its own pool credit.
    const redeem1 = await h.client.redemptionTransaction(market, alice.publicKey, 1, 4_000n, 4_000n);
    expect(redeem1.recovery.merge).toBe(4_000n);
    await h.send(unwrap(redeem1, h.client.program), alice);
    await h.send(unwrap(await h.client.redemptionTransaction(market, alice.publicKey, 2, 7_000n, 0n), h.client.program), alice);
    expect(await credits()).toEqual([c1!, c2!]);
    await h.send(unwrap(await h.client.redemptionTransaction(market, bob.publicKey, 0, 3_000n, 0n), h.client.program), bob);
    expect((await h.client.market(market)).backing.map(big)).toEqual([0n, 0n, 0n, 0n]);
    expect(await liabilities()).toEqual([l1!, l2!]);
    await conserve();

    // INVALID on another market: odd claims are retained, never discarded.
    const invalid = await setup(["remora"]);
    const [leg] = invalid.legs;
    const start = await h.credit(leg!, alice.publicKey);
    await split(invalid.market, alice, 1, 10n);
    await h.send(
      [
        h.client.ix(
          "transfer_credit",
          { asset: claimAsset(1, 1), amount: bn(3) },
          {
            owner: alice.publicKey,
            market: invalid.market,
            source: walletAddress(invalid.market, alice.publicKey, h.client.program),
            destination: walletAddress(invalid.market, carol.publicKey, h.client.program),
          },
        ),
      ],
      alice,
    );
    const proof = digest("multi-issuer invalid"),
      reference = "ipfs://multi-issuer-invalid";
    await h.send([
      h.lifecycle(invalid.market, 1, digest("freeze")),
      h.lifecycle(
        invalid.market,
        3,
        resolutionHash(h.client.config, invalid.market, 1, 1, proof, reference, h.client.program),
      ),
      h.client.ix(
        "resolve",
        { yes: 1, no: 1, evidence: [...proof], uri: reference },
        { actor: h.admin.publicKey, config: h.client.config, market: invalid.market },
      ),
    ]);
    const recovery = await h.client.redemptionTransaction(invalid.market, alice.publicKey, 1, 10n, 7n);
    expect(recovery.recovery).toMatchObject({ merge: 7n, redeemYes: 2n, retainedYes: 1n, credit: 8n });
    await h.send(unwrap(recovery, h.client.program), alice);
    await h.rejects(h.send([h.client.redeem(invalid.market, alice.publicKey, 1, 1n, 0n)], alice), "FractionalRedemption");
    await h.send(
      unwrap(await h.client.redemptionTransaction(invalid.market, carol.publicKey, 1, 0n, 3n), h.client.program),
      carol,
    );
    expect(await h.credit(leg!, alice.publicKey)).toBe(start - 10n + 8n);
    expect(await h.credit(leg!, carol.publicKey)).toBe(1n);
    expect((await h.balances(invalid.market, alice.publicKey))[claimAsset(1, 0)]).toBe(1n);
    await conserve();
  }, 300_000);

  test("an issuer-frozen pool vault halts new exposure until the issuer thaws it", async () => {
    const {
      market,
      legs: [frozen],
    } = await setup(["remora", "ondo"]);
    const resting = ask(market, 1);
    await h.place(resting, alice);
    await h.send([createFreezeAccountInstruction(poolVault(frozen!), frozen!, h.admin.publicKey, [], T22)]);
    const { legs } = await h.legs(market);
    expect(legs[1]!.halt).toBe("vault-frozen");
    expect(legs[2]!.tradable).toBe(true);
    await h.rejects(h.place(ask(market, 1), alice, [], { live: false }), "LegHalted");
    await h.rejects(split(market, alice, 1, 10n), "LegHalted");
    await h.rejects(forced(bid(market, legBit(1)), bob, [resting]), "LegHalted");
    await h.rejects(deposit(alice, frozen!, 10n));
    expect((await h.place(ask(market, 2), alice)).makers).toHaveLength(0);
    await h.send([createThawAccountInstruction(poolVault(frozen!), frozen!, h.admin.publicKey, [], T22)]);
    expect((await h.legs(market)).legs[1]!.tradable).toBe(true);
    expect((await h.place(bid(market, legBit(1)), bob, [resting])).makers).toHaveLength(1);
    await split(market, alice, 1, 10n);
    await conserve();
  }, 240_000);
});
