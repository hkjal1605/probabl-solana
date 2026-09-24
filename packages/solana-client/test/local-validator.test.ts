import { beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  createBurnInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  assetCreditAddress,
  baseRaw,
  big,
  bn,
  coder,
  claimAddress,
  claimAsset,
  digest,
  envelope,
  key,
  legBit,
  orderId,
  poolAddress,
  poolVaultAddress,
  resolutionHash,
  traderAddress,
  underlyingAsset,
  unwrap,
  vaultAddress,
  walletAddress,
  type AssetPoolAccount,
  type OrderWire,
  type TraderAccount,
} from "../src/index.ts";
import { assertMarketInvariants } from "./validator-invariants.ts";
import { ValidatorHarness } from "./validator-harness.ts";

/** Base leg 1 and the quote in the multi-issuer asset layout. */
const LEG = 1;
const BASE = underlyingAsset(LEG); // 3: leg-1 underlying (pool credit)
const baseClaim = (branch: number) => claimAsset(LEG, branch); // 4 YES, 5 NO
const quoteClaim = (branch: number) => claimAsset(0, branch); // 1 YES, 2 NO
const WAD = 10n ** 18n;

const rpc = process.env.SOLANA_TEST_RPC;
describe.skipIf(!rpc)("compiled Solana program on local validator", () => {
  const h = new ValidatorHarness(rpc ?? "http://127.0.0.1:8899");
  const attacker = Keypair.generate();
  let quote: PublicKey;
  const client = () => h.client;
  const send = (ixs: TransactionInstruction[], payer = h.admin, others: Keypair[] = []) =>
    h.send(ixs, payer, others);

  beforeAll(async () => {
    await h.airdrop(h.admin.publicKey, attacker.publicKey);
    quote = await h.plainMint(6, TOKEN_PROGRAM_ID);
    await h.initialize(quote);
    // A freshly started validator needs time for its first finalized slots.
  }, 180_000);

  type Users = { alice: Keypair; bob: Keypair };
  const funded = new Set<string>();
  async function users(): Promise<Users> {
    const pair = { alice: Keypair.generate(), bob: Keypair.generate() };
    await h.airdrop(pair.alice.publicKey, pair.bob.publicKey);
    return pair;
  }
  async function fundQuote(owner: PublicKey) {
    if (funded.has(owner.toBase58())) return;
    funded.add(owner.toBase58());
    await h.fund(quote, owner, 1_000_000_000n);
  }

  /** One base leg (classic 6-decimal mint by default: share_decimals 6 → scale 1,
   * multiplier 1.0, so raw base units equal share units). Alice deposits base
   * into protocol-wide pool credit, Bob deposits quote. */
  async function fixture(
    options: {
      terms?: Record<string, unknown>;
      base?: PublicKey;
      shareDecimals?: number;
      people?: Users;
      baseDeposit?: bigint;
      quoteDeposit?: bigint;
    } = {},
  ) {
    const people = options.people ?? (await users());
    const { alice, bob } = people;
    let base = options.base;
    if (!base) {
      base = await h.plainMint(6, TOKEN_PROGRAM_ID);
      for (const owner of [alice, bob]) await h.fund(base, owner.publicKey, 1_000_000_000n);
    }
    await fundQuote(bob.publicKey);
    const market = await h.market(
      [base],
      {
        tick: bn(WAD / 2n),
        step: bn(2),
        max_quantity: bn(1_000_000_000),
        max_order: bn(1_000_000_000_000n),
        max_wallet: bn(2_000_000_000_000n),
        max_market: bn(4_000_000_000_000n),
        ...options.terms,
      },
      { shareDecimals: options.shareDecimals ?? 6 },
    );
    // Refresh the SDK's remembered market image: legs were listed after creation.
    await client().market(market);
    for (const owner of [alice, bob]) await send([client().initializeWallet(market, owner.publicKey, h.admin.publicKey)]);
    const program = await h.programOf(base);
    if ((options.baseDeposit ?? 100n) > 0n)
      await send([client().depositPool(alice.publicKey, base, options.baseDeposit ?? 100n, program)], alice);
    if ((options.quoteDeposit ?? 1_000n) > 0n)
      await send([client().depositPool(bob.publicKey, quote, options.quoteDeposit ?? 1_000n)], bob);
    return { market, base, alice, bob };
  }
  const order = (
    market: PublicKey,
    owner: Keypair,
    side: number,
    funding: number,
    branch: number,
    quantity = 100,
  ): OrderWire =>
    h.order(market, owner, {
      side,
      fundingKind: funding,
      branch,
      quantity: String(quantity),
      limitPriceRawX18: String(BigInt(side === 0 ? 6 : 5) * WAD),
      tif: side === 0 ? 1 : 0,
      bases: legBit(LEG),
    });
  const place = (o: OrderWire, owner: Keypair, makers: OrderWire[] = []) => h.place(o, owner, makers);
  /** Position instructions need the owner's pool credit account (idempotent). */
  const position = (
    kind: "split" | "merge" | "redeem",
    market: PublicKey,
    owner: Keypair,
    collateral: number,
    amount: bigint,
    branch = 0,
  ) => [
    client().positionCredit(market, owner.publicKey, collateral),
    client().position(kind, market, owner.publicKey, collateral, amount, branch),
  ];
  const resolve = async (market: PublicKey, yes: number, no: number, label: string, archive = false) => {
    const evidence = digest(label + " evidence"),
      uri = "ipfs://" + label;
    await send([
      h.lifecycle(market, 1, digest(label + " freeze")),
      h.lifecycle(market, 3, resolutionHash(client().config, market, yes, no, evidence, uri)),
      client().ix(
        "resolve",
        { yes, no, evidence: [...evidence], uri },
        { actor: h.admin.publicKey, config: client().config, market, system_program: SystemProgram.programId },
      ),
      ...(archive ? [h.lifecycle(market, 4, digest(label + " archive"))] : []),
    ]);
  };
  const pause = (paused: boolean) =>
    send([
      client().ix(
        "pause",
        { paused, reason: [...digest(paused ? "pause" : "resume")] },
        { guardian: h.admin.publicKey, config: client().config },
      ),
    ]);
  const pool = (mint: PublicKey) => poolAddress(client().config, mint, client().program);
  const credit = (mint: PublicKey, owner: Keypair) => h.credit(mint, owner.publicKey);

  for (const branch of [0, 1])
    for (const sellFunding of [0, 1])
      for (const buyFunding of [0, 1]) {
        test(`branch ${branch}: seller funding ${sellFunding}, buyer funding ${buyFunding}; escrow, fees, recovery and redemption`, async () => {
          const { market, base, alice, bob } = await fixture();
          if (sellFunding) await send(position("split", market, alice, LEG, 100n), alice);
          if (buyFunding) await send(position("split", market, bob, 0, 1_000n), bob);
          const ask = order(market, alice, 1, sellFunding, branch),
            bid = order(market, bob, 0, buyFunding, branch, 50);
          await place(ask, alice);
          await assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey], [key(orderId(ask))]);
          if (!sellFunding) expect(await credit(base, alice)).toBe(0n);
          await place(bid, bob, [ask]);
          const audit = () =>
            assertMarketInvariants(
              client(),
              market,
              [alice.publicKey, bob.publicKey],
              [key(orderId(ask)), key(orderId(bid))],
            );
          await audit();
          const buyer = await h.balances(market, bob.publicKey),
            seller = await h.balances(market, alice.publicKey);
          expect(buyer[baseClaim(branch)]).toBe(50n);
          expect(seller[quoteClaim(branch)]).toBe(250n);
          // Underlying lives in protocol-wide AssetCredit, never the market wallet.
          expect(buyer[BASE]).toBe(0n);
          expect(buyer[0]).toBe(0n);
          if (buyFunding) expect(buyer[quoteClaim(branch)]).toBe(750n);
          else {
            expect(await credit(quote, bob)).toBe(750n);
            expect(buyer[quoteClaim(1 - branch)]).toBe(250n);
          }
          if (!sellFunding) expect(seller[baseClaim(1 - branch)]).toBe(50n);
          const askKey = key(orderId(ask));
          expect(big((await client().order(askKey)).remaining)).toBe(50n);
          const before = (await h.connection.getAccountInfo(market))!.data;
          await h.rejects(send([await client().cancel(askKey, attacker.publicKey)], attacker), "Unauthorized");
          expect((await h.connection.getAccountInfo(market))!.data.equals(before)).toBe(true);
          // Pause never traps recoverable escrow, complete sets or credited assets.
          await pause(true);
          try {
            await send([await client().cancel(askKey, alice.publicKey)], alice);
            await audit();
            const cancelled = await client().order(askKey);
            expect(cancelled.status).toBe(3);
            expect(big(cancelled.filled)).toBe(50n);
            expect(big(cancelled.remaining)).toBe(0n);
            if (sellFunding) expect((await h.balances(market, alice.publicKey))[baseClaim(branch)]).toBe(50n);
            else expect(await credit(base, alice)).toBe(50n);
            const claim = claimAddress(market, baseClaim(branch));
            await send(client().withdraw(market, bob.publicKey, claim, baseClaim(branch), 50n), bob);
            expect((await getAccount(h.connection, getAssociatedTokenAddressSync(claim, bob.publicKey))).amount).toBe(50n);
            await audit();
            await send([client().deposit(market, bob.publicKey, claim, baseClaim(branch), 50n)], bob);
            const yes = branch === 0 ? 1 : 0,
              no = 1 - yes,
              evidence = digest("evidence"),
              uri = "ipfs://resolution";
            await send([h.lifecycle(market, 1, digest("freeze"))]);
            await send([h.lifecycle(market, 3, resolutionHash(client().config, market, yes, no, evidence, uri))]);
            const resolveIx = (u: string) =>
              client().ix(
                "resolve",
                { yes, no, evidence: [...evidence], uri: u },
                { actor: h.admin.publicKey, config: client().config, market, system_program: SystemProgram.programId },
              );
            await h.rejects(send([resolveIx(uri + "wrong")]));
            await send([resolveIx(uri)]);
            await h.rejects(send([resolveIx(uri)]), "InvalidState");
            const bobBase = await credit(base, bob);
            await send(position("redeem", market, bob, LEG, 50n, branch), bob);
            await audit();
            expect(await credit(base, bob)).toBe(bobBase + 50n);
            const state = await client().market(market);
            expect(big(state.open_notional)).toBe(0n);
          } finally {
            await pause(false);
          }
        }, 120_000);
      }

  test("reject substituted vault/mint, duplicate accounts, stale guards, replay, fee caps and IOC escrow retention", async () => {
    const { market, alice, bob } = await fixture(),
      ask = order(market, alice, 1, 0, 0);
    const { market: state, plan: empty } = await h.plan(ask);
    const good = client().placement(ask, empty, state),
      before = (await h.connection.getAccountInfo(market))!.data;
    const index = (ix: TransactionInstruction, pubkey: PublicKey) => ix.keys.findIndex((k) => k.pubkey.equals(pubkey));
    const duplicate = client().placement(ask, empty, state);
    duplicate.keys[index(duplicate, vaultAddress(market, baseClaim(1)))] = {
      ...duplicate.keys[index(duplicate, vaultAddress(market, baseClaim(0)))]!,
    };
    await h.rejects(send([duplicate], alice), "InvalidAccount");
    const foreign = client().placement(ask, empty, state);
    const legMint = index(foreign, state.mints[BASE]!);
    foreign.keys[legMint] = { ...foreign.keys[legMint]!, pubkey: quote };
    await h.rejects(send([foreign], alice));
    const foreignVault = client().placement(ask, empty, state);
    const vault = index(foreignVault, poolVaultAddress(pool(state.mints[BASE]!)));
    foreignVault.keys[vault] = { ...foreignVault.keys[vault]!, pubkey: poolVaultAddress(pool(quote)) };
    await h.rejects(send([foreignVault], alice), "InvalidAccount");
    const unsigned = client().placement(ask, empty, state);
    unsigned.keys[0] = { ...unsigned.keys[0]!, isSigner: false };
    await h.rejects(send([unsigned], attacker));
    expect((await h.connection.getAccountInfo(market))!.data.equals(before)).toBe(true);
    await send([good], alice);
    await h.rejects(send([good], alice));
    const bid = order(market, bob, 0, 0, 0, 50);
    const { plan } = await h.plan(bid, [ask]);
    const stale = { ...plan, guard: { ...plan.guard, nextSequence: "0" } };
    await h.rejects(send([client().placement(bid, stale, state)], bob));
    // A plan from a book the chain has not reached, or demanding more fill
    // than the makers can give, is stale (clients replan).
    const future = { ...plan, guard: { ...plan.guard, nextSequence: String(BigInt(plan.guard.nextSequence) + 1n) } };
    await h.rejects(send([client().placement(bid, future, state)], bob), "StalePlan");
    const greedy = { ...plan, minFill: String(BigInt(plan.filledQuantity) + 1n) };
    expect(() => client().placement(bid, greedy, state)).toThrow("Plan totals");
    const forced = client().placement(bid, plan, state);
    const args = coder.instruction.decode(forced.data)!.data as { plan: { min_fill: unknown } };
    args.plan.min_fill = bn(greedy.minFill);
    forced.data = coder.instruction.encode("place", args);
    await h.rejects(send([forced], bob), "StalePlan");
    await h.configure(100, 200);
    try {
      await h.rejects(send([client().placement(bid, plan, state)], bob));
      const updated = { ...plan, guard: { ...plan.guard, makerFeeBps: 100, takerFeeBps: 200 } };
      await send([client().placement(bid, updated, state)], bob);
      // Buyer fee on 50 raw base claims at 2%; seller fee on 250 quote at 1%.
      expect((await h.balances(market, bob.publicKey))[baseClaim(0)]).toBe(49n);
      expect((await h.balances(market, alice.publicKey))[quoteClaim(0)]).toBe(248n);
      const fees = (await client().market(market)).fees.map(big);
      expect(fees).toEqual(fees.map((_, asset) => (asset === baseClaim(0) ? 1n : asset === quoteClaim(0) ? 2n : 0n)));
      const collect = (amount: number, admin = h.admin) =>
        client().ix(
          "claim_fees",
          { asset: baseClaim(0), amount: bn(amount) },
          { admin: admin.publicKey, config: client().config, market, destination: walletAddress(market, bob.publicKey) },
        );
      await h.rejects(send([collect(1, attacker)], attacker));
      await h.rejects(send([collect(2)]), "InsufficientFunds");
      await send([collect(1)]);
      await assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey], [key(orderId(ask)), key(orderId(bid))]);
      expect(big((await client().market(market)).fees[baseClaim(0)]!)).toBe(0n);
      expect((await h.balances(market, bob.publicKey))[baseClaim(0)]).toBe(50n);
      await h.rejects(send([collect(1)]));
      const transfer = (owner: Keypair) =>
        client().ix(
          "transfer_credit",
          { asset: baseClaim(0), amount: bn(7) },
          {
            owner: owner.publicKey,
            market,
            source: walletAddress(market, bob.publicKey),
            destination: walletAddress(market, alice.publicKey),
          },
        );
      await h.rejects(send([transfer(attacker)], attacker));
      // Underlying credit is not a transferable wallet asset.
      await h.rejects(
        send(
          [
            client().ix(
              "transfer_credit",
              { asset: BASE, amount: bn(1) },
              {
                owner: bob.publicKey,
                market,
                source: walletAddress(market, bob.publicKey),
                destination: walletAddress(market, alice.publicKey),
              },
            ),
          ],
          bob,
        ),
        "InvalidAsset",
      );
      await send([transfer(bob)], bob);
      await assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey], [key(orderId(ask)), key(orderId(bid))]);
      expect((await h.balances(market, alice.publicKey))[baseClaim(0)]).toBe(7n);
      expect((await h.balances(market, bob.publicKey))[baseClaim(0)]).toBe(43n);
    } finally {
      await h.configure(0, 0);
    }
    const ioc = { ...order(market, bob, 0, 0, 1, 10), tif: 1 };
    const balanceBefore = await credit(quote, bob);
    await place(ioc, bob);
    expect(await credit(quote, bob)).toBe(balanceBefore);
    expect((await client().order(key(orderId(ioc)))).status).toBe(3);
    expect(big((await client().order(key(orderId(ioc)))).filled)).toBe(0n);
  }, 120_000);

  test("whole-funded multi-maker settlement accumulates every claim supply delta", async () => {
    const { market, alice, bob } = await fixture();
    const first = order(market, alice, 1, 0, 0, 2);
    const second = order(market, alice, 1, 0, 0, 4);
    await place(first, alice);
    await place(second, alice);
    const bid = order(market, bob, 0, 0, 0, 6);
    const { market: state, plan } = await h.plan(bid, [first, second]);
    expect(plan.makers).toHaveLength(2);
    const built = await client().prepareTransaction(bob.publicKey, envelope([client().placement(bid, plan, state)]));
    built.transaction.sign([bob]);
    const signature = await h.connection.sendRawTransaction(built.transaction.serialize());
    const result = await h.connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      "confirmed",
    );
    expect(result.value.err).toBeNull();
    const detail = await h.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(detail!.meta!.computeUnitsConsumed!).toBeLessThan(400_000);
    const backing = (await client().market(market)).backing.map(big);
    expect(backing).toEqual([30n, 6n, 0n, 0n]);
    for (const [collateral, supply] of [
      [0, 30n],
      [LEG, 6n],
    ] as const)
      for (const branch of [0, 1])
        expect((await getMint(h.connection, claimAddress(market, claimAsset(collateral, branch)))).supply).toBe(supply);
    await assertMarketInvariants(
      client(),
      market,
      [alice.publicKey, bob.publicKey],
      [first, second, bid].map((o) => key(orderId(o))),
    );
  }, 90_000);

  test("self-trades and a shared non-owner recipient preserve aggregate credits", async () => {
    const people = await users();
    await fundQuote(people.alice.publicKey);
    const { market, base, alice, bob } = await fixture({ people });
    await send([client().depositPool(alice.publicKey, quote, 500n)], alice);
    const ask = { ...order(market, alice, 1, 0, 0), recipient: bob.publicKey.toBase58() },
      bid = { ...order(market, alice, 0, 0, 0, 50), recipient: bob.publicKey.toBase58() };
    await place(ask, alice);
    await place(bid, alice, [ask]);
    const expected = (entries: Record<number, bigint>) => Array.from({ length: 12 }, (_, i) => entries[i] ?? 0n);
    expect(await h.balances(market, alice.publicKey)).toEqual(expected({ [quoteClaim(1)]: 250n, [baseClaim(1)]: 50n }));
    expect(await h.balances(market, bob.publicKey)).toEqual(expected({ [quoteClaim(0)]: 250n, [baseClaim(0)]: 50n }));
    expect(await credit(quote, alice)).toBe(250n);
    expect(await credit(base, alice)).toBe(0n);
    expect(await credit(quote, bob)).toBe(1_000n);
    expect(big((await client().order(key(orderId(ask)))).filled)).toBe(50n);
    await send([await client().cancel(key(orderId(ask)), alice.publicKey)], alice);
    expect(await credit(base, alice)).toBe(50n);
    await assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey], [ask, bid].map((o) => key(orderId(o))));
  }, 90_000);

  test("final-state caps roll back earlier token CPIs; IOC releases its remainder before checking caps", async () => {
    const { market, base, alice, bob } = await fixture({
      terms: { max_order: bn(160), max_wallet: bn(160), max_market: bn(160) },
    });
    const ask = order(market, alice, 1, 0, 0, 10),
      other = order(market, alice, 1, 0, 1, 20);
    await place(ask, alice);
    await place(other, alice);
    const bid = { ...order(market, bob, 0, 0, 0, 20), limitPriceRawX18: String(8n * WAD), tif: 0 };
    const accounts = [
      market,
      walletAddress(market, alice.publicKey),
      walletAddress(market, bob.publicKey),
      key(orderId(ask)),
      assetCreditAddress(pool(quote), bob.publicKey),
      assetCreditAddress(pool(base), alice.publicKey),
      ...[1, 2, 4, 5].flatMap((asset) => [vaultAddress(market, asset), claimAddress(market, asset)]),
    ];
    const before = await h.snapshot(accounts);
    await h.rejects(place(bid, bob, [ask]), undefined, accounts, before);
    expect(await h.connection.getAccountInfo(key(orderId(bid)))).toBeNull();
    await place({ ...bid, tif: 1 }, bob, [ask]);
    const filled = await client().order(key(orderId(bid)));
    expect(big(filled.filled)).toBe(10n);
    expect(filled.status).toBe(3);
    expect(big(filled.reserved)).toBe(0n);
    expect(big((await client().market(market)).open_notional)).toBe(100n);
    expect(await credit(quote, bob)).toBe(950n);
    expect((await h.balances(market, bob.publicKey))[baseClaim(0)]).toBe(10n);
  }, 90_000);

  test("INVALID rejects fractional burns and combines odd pairs exactly after archival", async () => {
    const { market, base, alice } = await fixture();
    await send(position("split", market, alice, LEG, 9n), alice);
    await h.rejects(send(position("redeem", market, alice, LEG, 1n, 0), alice), "InvalidState");
    await resolve(market, 1, 1, "invalid", true);
    await send(position("merge", market, alice, LEG, 7n), alice);
    expect(await credit(base, alice)).toBe(98n);
    const protectedAccounts = [
      market,
      walletAddress(market, alice.publicKey),
      assetCreditAddress(pool(base), alice.publicKey),
      ...[4, 5].flatMap((asset) => [claimAddress(market, asset), vaultAddress(market, asset)]),
    ];
    const beforeOdd = await h.snapshot(protectedAccounts);
    await h.rejects(
      send(position("redeem", market, alice, LEG, 1n, 0), alice),
      "FractionalRedemption",
      protectedAccounts,
      beforeOdd,
    );
    expect(await credit(base, alice)).toBe(98n);
    await send([client().positionCredit(market, alice.publicKey, LEG), client().redeem(market, alice.publicKey, LEG, 1n, 1n)], alice);
    expect(await credit(base, alice)).toBe(99n);
    expect(big((await client().market(market)).backing[LEG]!)).toBe(1n);
    await send(position("merge", market, alice, LEG, 1n), alice);
    expect((await h.balances(market, alice.publicKey)).slice(4, 6)).toEqual([0n, 0n]);
    expect(await credit(base, alice)).toBe(100n);
    // All nine complete sets recovered exactly: no newly stranded backing dust.
    const state = await client().market(market);
    expect(big(state.backing[LEG]!)).toBe(0n);
    expect(state.fees.map(big).every((f) => f === 0n)).toBe(true);
    for (const asset of [1, 2, 4, 5])
      expect((await getAccount(h.connection, vaultAddress(market, asset))).amount).toBe(
        big(state.credits[asset]!) + big(state.escrow[asset]!) + big(state.fees[asset]!),
      );
    expect(big((await client().fetch<AssetPoolAccount>("AssetPool", pool(base))).liability)).toBe(100n);
    await assertMarketInvariants(client(), market, [alice.publicKey]);
  }, 90_000);

  test("exact recovery handles zero-decimal external claims and preserves a reusable odd remainder", async () => {
    const people = await users();
    const { alice, bob } = people;
    const indivisible = await h.plainMint(0, TOKEN_PROGRAM_ID);
    await h.fund(indivisible, alice.publicKey, 100n);
    const { market } = await fixture({ base: indivisible, shareDecimals: 0, people });
    expect((await client().market(market)).decimals[LEG]).toBe(0);
    await send(position("split", market, alice, LEG, 9n), alice);
    const yesMint = claimAddress(market, baseClaim(0)),
      noMint = claimAddress(market, baseClaim(1));
    await send(await client().withdrawCredit(market, alice.publicKey, yesMint, baseClaim(0), 4n), alice);
    await send(await client().withdrawCredit(market, alice.publicKey, noMint, baseClaim(1), 7n), alice);
    const aliceYes = getAssociatedTokenAddressSync(yesMint, alice.publicKey);
    const aliceNo = getAssociatedTokenAddressSync(noMint, alice.publicKey);
    const bobNo = await getOrCreateAssociatedTokenAccount(h.connection, h.admin, noMint, bob.publicKey);
    await send([createTransferInstruction(aliceNo, bobNo.address, alice.publicKey, 7n)], alice);
    await resolve(market, 1, 1, "exact-recovery");
    const recovery = await client().redemptionTransaction(market, alice.publicKey, LEG, 9n, 2n);
    expect(recovery.recovery).toEqual({
      merge: 2n,
      redeemYes: 6n,
      redeemNo: 0n,
      retainedYes: 1n,
      retainedNo: 0n,
      credit: 5n,
      burnYes: 8n,
      burnNo: 2n,
    });
    await send(unwrap(recovery), alice);
    expect(await credit(indivisible, alice)).toBe(96n);
    expect((await getAccount(h.connection, aliceYes)).amount).toBe(1n);
    expect((await getAccount(h.connection, bobNo.address)).amount).toBe(7n);
    const audit = () => assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey]);
    await audit();
    const protectedAccounts = [market, walletAddress(market, alice.publicKey), aliceYes];
    const before = await h.snapshot(protectedAccounts);
    for (let i = 0; i < 3; i++) {
      const odd = await client().redemptionTransaction(market, alice.publicKey, LEG, 1n, 0n);
      expect(odd.executable).toBe(false);
      expect(odd.recovery.retainedYes).toBe(1n);
      expect(() => unwrap(odd)).toThrow();
    }
    expect(await h.snapshot(protectedAccounts)).toEqual(before);
    // The retained claim remains transferable/combinable, not a discarded IOU.
    await send([createTransferInstruction(bobNo.address, aliceNo, bob.publicKey, 1n)], bob);
    await send(unwrap(await client().redemptionTransaction(market, alice.publicKey, LEG, 1n, 1n)), alice);
    await send(unwrap(await client().redemptionTransaction(market, bob.publicKey, LEG, 0n, 6n)), bob);
    expect(await credit(indivisible, alice)).toBe(97n);
    expect(await credit(indivisible, bob)).toBe(3n);
    expect((await client().market(market)).backing.map(big)).toEqual([0n, 0n, 0n, 0n]);
    expect((await getMint(h.connection, yesMint)).supply).toBe(0n);
    expect((await getMint(h.connection, noMint)).supply).toBe(0n);
    await audit();
  }, 90_000);

  for (const payouts of [
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    test(`audit stateful conservation through external claims, burns, resolution ${payouts} and archive`, async () => {
      const people = await users();
      await fundQuote(people.alice.publicKey);
      const { market, base, alice, bob } = await fixture({ people });
      const owners = [alice.publicKey, bob.publicKey];
      const audit = () => assertMarketInvariants(client(), market, owners);
      const mintOf = [quote, base];
      await send([client().depositPool(alice.publicKey, quote, 1_000n)], alice);
      await send([client().depositPool(bob.publicKey, base, 100n)], bob);
      await send(position("split", market, alice, LEG, 40n), alice);
      await send(position("split", market, bob, 0, 400n), bob);
      await audit();

      // Total mint supply must include external holders, and voluntary burns
      // may only create surplus backing, never credits to an unrelated wallet.
      const mint = claimAddress(market, baseClaim(0));
      await send(client().withdraw(market, alice.publicKey, mint, baseClaim(0), 11n), alice);
      await audit();
      const bobAta = await getOrCreateAssociatedTokenAccount(h.connection, h.admin, mint, bob.publicKey);
      await send(
        [createTransferInstruction(getAssociatedTokenAddressSync(mint, alice.publicKey), bobAta.address, alice.publicKey, 4n)],
        alice,
      );
      await audit();
      await send([client().deposit(market, bob.publicKey, mint, baseClaim(0), 3n)], bob);
      await audit();
      const beforeBurn = await client().market(market);
      const supplyBefore = (await getMint(h.connection, mint)).supply;
      await send([createBurnInstruction(bobAta.address, mint, bob.publicKey, 1n)], bob);
      expect((await getMint(h.connection, mint)).supply).toBe(supplyBefore - 1n);
      expect((await client().market(market)).backing.map(big)).toEqual(beforeBurn.backing.map(big));
      await audit();

      let random = 0x5a17;
      const next = () => {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        return random >>> 0;
      };
      const actions = [0, 0, 0, 0];
      for (let step = 0; step < 32; step++) {
        if (step === 16) {
          await resolve(market, payouts[0], payouts[1], "comparative-audit");
          await audit();
        }
        if (step === 24) {
          await send([h.lifecycle(market, 4, digest("audit archive"))]);
          await audit();
        }
        const owner = next() % 2 === 0 ? alice : bob;
        const other = owner === alice ? bob : alice;
        const collateral = next() % 2,
          i = claimAsset(collateral, 0);
        const balances = await h.balances(market, owner.publicKey);
        const available = await credit(mintOf[collateral]!, owner);
        const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
        const wanted = BigInt((next() % 9) + 1);
        const action = step % 4;
        if (action === 0 || (action === 3 && step < 16)) {
          const amount = min(available, wanted);
          if (amount > 0n) {
            await send(position("split", market, owner, collateral, amount), owner);
            actions[0]!++;
          }
        } else if (action === 1) {
          const amount = min(balances[i]!, balances[i + 1]!, wanted);
          if (amount > 0n) {
            await send(position("merge", market, owner, collateral, amount), owner);
            actions[1]!++;
          }
        } else if (action === 2) {
          const amount = min(balances[i]!, wanted);
          if (amount > 0n) {
            await send(
              [
                client().ix(
                  "transfer_credit",
                  { asset: i, amount: bn(amount) },
                  {
                    owner: owner.publicKey,
                    market,
                    source: walletAddress(market, owner.publicKey),
                    destination: walletAddress(market, other.publicKey),
                  },
                ),
              ],
              owner,
            );
            actions[2]!++;
          }
        } else {
          let yes = min(balances[i]!, wanted),
            no = min(balances[i + 1]!, wanted + 1n);
          if (payouts[0] + payouts[1] === 2 && (yes + no) % 2n !== 0n) {
            if (no > 0n) no--;
            else yes--;
          }
          if (yes + no > 0n) {
            await send(
              [
                client().positionCredit(market, owner.publicKey, collateral),
                client().ix(
                  "redeem",
                  { collateral, yes_amount: bn(yes), no_amount: bn(no) },
                  {
                    owner: owner.publicKey,
                    market,
                    wallet: walletAddress(market, owner.publicKey),
                    yes_mint: claimAddress(market, i),
                    no_mint: claimAddress(market, i + 1),
                    yes_vault: vaultAddress(market, i),
                    no_vault: vaultAddress(market, i + 1),
                    token_program: TOKEN_PROGRAM_ID,
                    pool: pool(mintOf[collateral]!),
                    credit: assetCreditAddress(pool(mintOf[collateral]!), owner.publicKey),
                    underlying_vault: poolVaultAddress(pool(mintOf[collateral]!)),
                    underlying_mint: mintOf[collateral]!,
                  },
                ),
              ],
              owner,
            );
            const denominator = BigInt(payouts[0] + payouts[1]);
            const expected = (yes * BigInt(payouts[0]) + no * BigInt(payouts[1])) / denominator;
            expect(await credit(mintOf[collateral]!, owner)).toBe(available + expected);
            actions[3]!++;
          }
        }
        await audit();
      }
      expect(actions.every((count) => count > 0)).toBe(true);

      // A donation to the protocol-wide pool vault creates no market or user credit.
      const beforeDonation = (await h.connection.getAccountInfo(market))!.data;
      const liability = big((await client().fetch<AssetPoolAccount>("AssetPool", pool(base))).liability);
      const aliceBase = await credit(base, alice);
      await send(
        [
          createTransferInstruction(
            getAssociatedTokenAddressSync(base, alice.publicKey),
            poolVaultAddress(pool(base)),
            alice.publicKey,
            2n,
          ),
        ],
        alice,
      );
      expect((await h.connection.getAccountInfo(market))!.data.equals(beforeDonation)).toBe(true);
      expect(big((await client().fetch<AssetPoolAccount>("AssetPool", pool(base))).liability)).toBe(liability);
      expect(await credit(base, alice)).toBe(aliceBase);
      await audit();
      // Paused, archived complete-set recovery is intentionally different from MetaDAO.
      await pause(true);
      try {
        const collateral = (await credit(quote, alice)) >= 3n ? 0 : LEG;
        const beforeRecovery = await h.balances(market, alice.publicKey);
        const creditBefore = await credit(mintOf[collateral]!, alice);
        expect(creditBefore).toBeGreaterThanOrEqual(3n);
        await send(position("split", market, alice, collateral, 3n), alice);
        await audit();
        await send(position("merge", market, alice, collateral, 3n), alice);
        expect(await h.balances(market, alice.publicKey)).toEqual(beforeRecovery);
        expect(await credit(mintOf[collateral]!, alice)).toBe(creditBefore);
        await audit();
      } finally {
        await pause(false);
      }
    }, 180_000);
  }

  test("audit position account attacks and repeated redemption leave no partial state", async () => {
    const { market, base, alice, bob } = await fixture(),
      { market: foreign, base: foreignBase } = await fixture();
    await send(position("split", market, alice, LEG, 11n), alice);
    const accounts = [
      market,
      walletAddress(market, alice.publicKey),
      walletAddress(market, bob.publicKey),
      assetCreditAddress(pool(base), alice.publicKey),
      pool(base),
      ...[1, 2, 4, 5].flatMap((asset) => [vaultAddress(market, asset), claimAddress(market, asset)]),
    ];
    const attacks: TransactionInstruction[] = [];
    for (const [index, pubkey] of [
      [2, walletAddress(market, bob.publicKey)],
      [3, claimAddress(foreign, baseClaim(0))],
      [4, claimAddress(market, baseClaim(0))],
      [5, vaultAddress(foreign, baseClaim(0))],
      [6, vaultAddress(market, baseClaim(0))],
      [7, TOKEN_2022_PROGRAM_ID],
      [8, pool(quote)],
      [8, pool(foreignBase)],
      [9, assetCreditAddress(pool(base), bob.publicKey)],
      [10, poolVaultAddress(pool(foreignBase))],
      [11, foreignBase],
    ] as const) {
      const ix = client().position("merge", market, alice.publicKey, LEG, 1n);
      ix.keys[index] = { ...ix.keys[index]!, pubkey };
      attacks.push(ix);
    }
    attacks.push(client().position("split", market, alice.publicKey, LEG, 0n));
    attacks.push(client().position("merge", market, alice.publicKey, LEG, 12n));
    attacks.push(client().position("redeem", market, alice.publicKey, LEG, 1n, 0));
    // Claims of a listed leg cannot be minted outside the protocol either.
    attacks.push(createMintToInstruction(claimAddress(market, baseClaim(0)), vaultAddress(market, baseClaim(0)), alice.publicKey, 1n));
    for (const ix of attacks) {
      const before = await h.snapshot(accounts);
      await h.rejects(send([ix], alice), undefined, accounts, before);
    }
    // Positive control proves valid accounts and available balances still work.
    await send(position("merge", market, alice, LEG, 1n), alice);
    await resolve(market, 1, 0, "audit-replay");
    const redeem = client().position("redeem", market, alice.publicKey, LEG, 10n, 0);
    await send([redeem], alice);
    const before = await h.snapshot(accounts);
    // Different payer makes this a distinct transaction, not a cached signature.
    await h.rejects(send([redeem], h.admin, [alice]), undefined, accounts, before);
    expect(await credit(base, alice)).toBe(100n);
    await assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey]);
  }, 120_000);

  test("audit u64 supply overflow rolls back the first mint CPI and preserves recovery", async () => {
    const maximum = (1n << 64n) - 1n;
    const people = await users();
    const { alice, bob } = people;
    const mint = await h.plainMint(0, TOKEN_PROGRAM_ID);
    const ata = await h.fund(mint, alice.publicKey, maximum);
    const { market } = await fixture({ base: mint, shareDecimals: 0, people });
    const audit = () => assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey]);
    await send([client().depositPool(alice.publicKey, mint, maximum - 100n)], alice);
    expect(await credit(mint, alice)).toBe(maximum);
    await send(position("split", market, alice, LEG, maximum), alice);
    await audit();
    await resolve(market, 1, 0, "audit-u64");
    await send(position("redeem", market, alice, LEG, maximum, 0), alice);
    await audit();
    const accounts = [
      market,
      walletAddress(market, alice.publicKey),
      assetCreditAddress(pool(mint), alice.publicKey),
      ...[4, 5].flatMap((asset) => [claimAddress(market, asset), vaultAddress(market, asset)]),
    ];
    const before = await h.snapshot(accounts);
    // YES minting can succeed, but the outstanding losing NO supply is already
    // u64::MAX. Failure of the second CPI must undo the first mint and credits.
    await h.rejects(send(position("split", market, alice, LEG, 1n), alice), undefined, accounts, before);
    expect((await getMint(h.connection, claimAddress(market, baseClaim(0)))).supply).toBe(0n);
    expect((await getMint(h.connection, claimAddress(market, baseClaim(1)))).supply).toBe(maximum);
    await send(client().withdraw(market, alice.publicKey, mint, BASE, maximum), alice);
    expect((await getAccount(h.connection, ata)).amount).toBe(maximum);
    await audit();
    await send(position("redeem", market, alice, LEG, maximum, 1), alice);
    expect((await getMint(h.connection, claimAddress(market, baseClaim(1)))).supply).toBe(0n);
    await audit();
  }, 90_000);

  test("audit wrapped SOL collateral uses raw lamports and exact split/merge/redemption", async () => {
    const people = await users();
    const { alice, bob } = people;
    const ata = await getOrCreateAssociatedTokenAccount(h.connection, h.admin, NATIVE_MINT, alice.publicKey);
    await send(
      [
        SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: ata.address, lamports: 10_000 }),
        createSyncNativeInstruction(ata.address),
      ],
      alice,
    );
    const { market } = await fixture({ base: NATIVE_MINT, shareDecimals: 9, people });
    const audit = () => assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey]);
    const vault = poolVaultAddress(pool(NATIVE_MINT));
    expect((await getAccount(h.connection, vault)).isNative).toBe(true);
    expect((await getMint(h.connection, claimAddress(market, baseClaim(0)))).decimals).toBe(9);
    expect(await credit(NATIVE_MINT, alice)).toBe(100n);
    await audit();
    await send(position("split", market, alice, LEG, 99n), alice);
    await audit();
    await send(position("merge", market, alice, LEG, 39n), alice);
    await audit();
    await resolve(market, 0, 1, "audit-wsol");
    await send(position("redeem", market, alice, LEG, 60n, 1), alice);
    await audit();
    expect(await credit(NATIVE_MINT, alice)).toBe(100n);
    await send(client().withdraw(market, alice.publicKey, NATIVE_MINT, BASE, 100n), alice);
    expect(await credit(NATIVE_MINT, alice)).toBe(0n);
    const wallet = await h.balances(market, alice.publicKey);
    expect(wallet[BASE]).toBe(0n);
    // The losing YES claims remain as worthless, still-audited supply.
    expect([wallet[baseClaim(0)], wallet[baseClaim(1)]]).toEqual([60n, 0n]);
    expect((await getAccount(h.connection, vault)).amount).toBe(0n);
    await audit();
  }, 90_000);

  test("issuer-token legs convert share units at the live multiplier and refund the reservation surplus", async () => {
    const people = await users();
    const { alice, bob } = people;
    const issuer = await h.issuerMint("xstocks");
    await h.fund(issuer.mint, alice.publicKey, 10n ** 10n);
    const { market } = await fixture({
      base: issuer.mint,
      people,
      baseDeposit: 10n ** 9n,
      terms: { tick: bn(WAD / 10n), step: bn(10) },
    });
    const { market: state, legs } = await h.legs(market);
    const leg = legs[LEG]!;
    expect(leg.scale).toBe(100n); // 8 issuer decimals over 6 share decimals
    expect(leg.tradable).toBe(true);
    expect(leg.multiplierValue).toBeCloseTo(1.0017012, 6);
    expect(big(state.legs[0]!.multiplier)).toBe(leg.multiplier);
    const start = await credit(issuer.mint, alice);
    const ask = order(market, alice, 1, 0, 0, 100);
    await place(ask, alice);
    const reserved = baseRaw(100n, leg.scale, leg.multiplier, true);
    expect(big((await client().order(key(orderId(ask)))).reserved)).toBe(reserved);
    expect(await credit(issuer.mint, alice)).toBe(start - reserved);
    const first = order(market, bob, 0, 0, 0, 50);
    await place(first, bob, [ask]);
    const delivered = baseRaw(50n, leg.scale, leg.multiplier);
    expect((await h.balances(market, bob.publicKey))[baseClaim(0)]).toBe(delivered);
    expect((await h.balances(market, alice.publicKey))[baseClaim(1)]).toBe(delivered);
    const second = order(market, bob, 0, 0, 0, 50);
    await place(second, bob, [ask]);
    const completed = await client().order(key(orderId(ask)));
    expect(completed.status).toBe(2);
    // Round-down deliveries leave a surplus that returns to the seller's pool credit.
    expect(big(completed.reserved)).toBe(0n);
    expect(reserved - 2n * delivered).toBeGreaterThan(0n);
    expect(await credit(issuer.mint, alice)).toBe(start - 2n * delivered);
    expect(big((await client().market(market)).backing[LEG]!)).toBe(2n * delivered);
    await assertMarketInvariants(client(), market, [alice.publicKey, bob.publicKey], [ask, first, second].map((o) => key(orderId(o))));
  }, 120_000);

  test("owner-wide nonce invalidation spans markets and is never reset by wallet initialization", async () => {
    const people = await users();
    const { alice, bob } = people;
    const fixtures = [await fixture({ people }), await fixture({ people })],
      asks = fixtures.map((f) => order(f.market, alice, 1, 0, 0));
    for (const ask of asks) await place(ask, alice);
    const trader = traderAddress(client().config, alice.publicKey);
    await h.rejects(
      send([client().ix("invalidate_nonce", { minimum: bn(1) }, { owner: attacker.publicKey, trader })], attacker),
    );
    await send([client().invalidateNonce(alice.publicKey, 1n)], alice);
    for (const [i, { market, base }] of fixtures.entries()) {
      const ask = asks[i]!;
      await h.rejects(place(order(market, bob, 0, 0, 0, 10), bob, [ask]));
      // Stale makers can be released by anyone, but only to the original owner's credit.
      await send([await client().cancel(key(orderId(ask)), attacker.publicKey)], attacker);
      expect(await credit(base, alice)).toBe(100n);
    }
    const third = await fixture({ people });
    expect(big((await client().fetch<TraderAccount>("Trader", trader)).minimum_nonce)).toBe(1n);
    await h.rejects(place(order(third.market, alice, 1, 0, 0), alice));
    await place(
      h.order(third.market, alice, {
        side: 1,
        fundingKind: 0,
        branch: 0,
        quantity: "100",
        limitPriceRawX18: String(5n * WAD),
        tif: 0,
        bases: legBit(LEG),
        nonce: "1",
      }),
      alice,
    );
    await h.rejects(send([client().invalidateNonce(alice.publicKey, 1n)], alice));
  }, 120_000);
});
