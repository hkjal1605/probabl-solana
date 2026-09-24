import { beforeAll, describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID as T22,
  NATIVE_MINT,
  createSyncNativeInstruction,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  ExtensionType,
  getMintLen,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeMintCloseAuthorityInstruction,
  freezeAccount,
  thawAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  SolanaClient,
  configAddress,
  marketAddress,
  poolAddress,
  poolVaultAddress,
  assetCreditAddress,
  walletAddress,
  vaultAddress,
  claimAddress,
  bn,
  big,
  digest,
  coder,
  unwrap,
  planOrder,
  orderId,
  orderSalt,
  resolutionHash,
  legBit,
  allLegs,
  underlyingAsset,
  claimAsset,
  COLLATERALS,
  baseRaw,
  type OrderWire,
  type AssetPoolAccount,
  type MarketAccount,
} from "../src/index";
import { initializeMarketVaults } from "../src/admin";
import { mockIssuerInstructions } from "../../../scripts/solana/mock-issuers.ts";

const rpc = process.env.SOLANA_POOL_TEST_RPC;
describe.skipIf(!rpc)("protocol-wide custody on compiled Solana program", () => {
  const admin = Keypair.generate(),
    alice = Keypair.generate(),
    bob = Keypair.generate(),
    carol = Keypair.generate(),
    attacker = Keypair.generate();
  let client: SolanaClient, base: PublicKey, quote: PublicKey, issuer: PublicKey;
  // Market A lists [base]; market B lists [issuer, base]: one base pool backs
  // leg 1 of A and leg 2 of B.
  const markets: PublicKey[] = [];
  const LEGS = [1, 2];
  /** Collateral of `mint` in market `m` (0 = quote). */
  const collateral = (market: MarketAccount, mint: PublicKey) => {
    for (let c = 0; c < COLLATERALS; c++)
      if (market.mints[underlyingAsset(c)]!.equals(mint)) return c;
    return -1;
  };
  const programOf = (mint: PublicKey) => (mint.equals(base) ? TOKEN_PROGRAM_ID : T22);
  let nonce = 0;
  const connection = () => client.connection;
  async function send(
    instructions: TransactionInstruction[],
    payer = admin,
    others: Keypair[] = [],
  ) {
    const latest = await connection().getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
          ...instructions,
        ],
      }).compileToV0Message(),
    );
    tx.sign([payer, ...others]);
    // Preflight failures must leave ALL state untouched; positive transactions
    // are also actually submitted and confirmed, not just simulated.
    const signature = await connection().sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    const result = await connection().confirmTransaction({ ...latest, signature }, "confirmed");
    if (result.value.err) throw new Error(JSON.stringify(result.value.err));
  }
  const pool = (mint: PublicKey) => poolAddress(client.config, mint);
  const vault = (mint: PublicKey) => poolVaultAddress(pool(mint));
  const credit = (mint: PublicKey, owner = alice.publicKey) =>
    assetCreditAddress(pool(mint), owner);
  const available = async (mint: PublicKey, owner = alice.publicKey) =>
    big((await client.assetCredit(mint, owner))?.available ?? 0n);
  const poolState = (mint: PublicKey) => client.fetch<AssetPoolAccount>("AssetPool", pool(mint));
  async function state() {
    const keys = [
      pool(base),
      pool(quote),
      vault(base),
      vault(quote),
      credit(base),
      credit(quote),
      credit(base, bob.publicKey),
      credit(quote, bob.publicKey),
      ...markets.flatMap((m) => [
        m,
        walletAddress(m, alice.publicKey),
        walletAddress(m, bob.publicKey),
        ...[1, 2, 4, 5, 7, 8].flatMap((a) => [claimAddress(m, a), vaultAddress(m, a)]),
      ]),
    ];
    return (await connection().getMultipleAccountsInfo(keys)).map(
      (a) => a?.data.toString("base64") ?? null,
    );
  }
  /** Per mint: pool liability == Σ available credit + Σ over markets (escrow +
   * backing) of whichever collateral that mint is in each market. */
  async function invariant() {
    for (const mint of [base, quote, issuer]) {
      let liabilities = 0n;
      for (const owner of [alice, bob, carol])
        liabilities += await available(mint, owner.publicKey);
      for (const m of markets) {
        const market = await client.market(m);
        for (let c = 0; c < COLLATERALS; c++)
          expect(big(market.credits[underlyingAsset(c)]!)).toBe(0n);
        for (const owner of [alice, bob]) {
          const w = await client.wallet(m, owner.publicKey);
          for (let c = 0; c < COLLATERALS; c++)
            expect(big(w!.balances[underlyingAsset(c)]!)).toBe(0n);
        }
        const c = collateral(market, mint);
        if (c < 0) continue;
        liabilities += big(market.escrow[underlyingAsset(c)]!) + big(market.backing[c]!);
        const yes = await getMint(connection(), market.mints[claimAsset(c, 0)]!);
        const no = await getMint(connection(), market.mints[claimAsset(c, 1)]!);
        const backing = big(market.backing[c]!);
        const required =
          market.state >= 6
            ? (yes.supply * BigInt(market.payouts[0]!) +
                no.supply * BigInt(market.payouts[1]!) +
                BigInt(market.payouts[0]! + market.payouts[1]!) -
                1n) /
              BigInt(market.payouts[0]! + market.payouts[1]!)
            : yes.supply > no.supply
              ? yes.supply
              : no.supply;
        expect(backing >= required).toBe(true);
      }
      expect(big((await poolState(mint)).liability)).toBe(liabilities);
      expect(
        (await getAccount(connection(), vault(mint), "confirmed", programOf(mint))).amount >=
          liabilities,
      ).toBe(true);
    }
  }
  function order(
    market: PublicKey,
    owner: Keypair,
    side: number,
    quantity = 10n,
    price = 2n * 10n ** 18n,
    fundingKind = 0,
    bases?: number,
  ): OrderWire {
    return {
      maker: owner.publicKey.toBase58(),
      recipient: owner.publicKey.toBase58(),
      marketId: market.toBase58(),
      salt: orderSalt(0n, digest(`pool-order-${nonce++}`)),
      quantity: String(quantity),
      limitPriceRawX18: String(price),
      expiry: String(Math.floor(Date.now() / 1000) + 1800),
      nonce: "0",
      branch: 0,
      side,
      tif: 0,
      fundingKind,
      maxFeeBps: 1000,
      // Sells deliver the shared base leg; bids accept every listed leg.
      bases:
        bases ??
        (side === 1
          ? legBit(LEGS[markets.indexOf(market)]!)
          : allLegs(markets.indexOf(market) + 1)),
    };
  }
  async function place(o: OrderWire, payer: Keypair, makers: OrderWire[] = []) {
    const m = await client.market(new PublicKey(o.marketId));
    const candidates = await Promise.all(
      makers.map(async (maker) => {
        const a = await client.order(new PublicKey(orderId(maker)));
        return {
          order: maker,
          orderHash: orderId(maker),
          remaining: big(a.remaining),
          sequence: big(a.sequence),
        };
      }),
    );
    const plan = planOrder({
      order: o,
      candidates,
      now: BigInt(Math.floor(Date.now() / 1000)),
      step: big(m.terms.step),
      nextSequence: big(m.sequence[o.branch]!),
      makerFeeBps: 10,
      takerFeeBps: 20,
      program: client.program,
    });
    await send([client.placement(o, plan, m)], payer);
  }
  beforeAll(async () => {
    if (!rpc || !["127.0.0.1", "localhost"].includes(new URL(rpc).hostname))
      throw new Error("Disposable localhost only");
    client = new SolanaClient({
      rpcUrl: rpc,
      config: configAddress(admin.publicKey).toBase58(),
      genesisHash: "local",
    });
    for (const owner of [admin, alice, bob, carol, attacker])
      await connection().confirmTransaction(
        await connection().requestAirdrop(owner.publicKey, 20_000_000_000),
        "confirmed",
      );
    base = await createMint(connection(), admin, admin.publicKey, null, 6);
    const mint = Keypair.generate(),
      space = getMintLen([ExtensionType.TransferFeeConfig]);
    const latest = await connection().getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: admin.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [
          SystemProgram.createAccount({
            fromPubkey: admin.publicKey,
            newAccountPubkey: mint.publicKey,
            space,
            lamports: await connection().getMinimumBalanceForRentExemption(space),
            programId: T22,
          }),
          createInitializeTransferFeeConfigInstruction(
            mint.publicKey,
            admin.publicKey,
            admin.publicKey,
            125,
            1000n,
            T22,
          ),
          createInitializeMintInstruction(mint.publicKey, 6, admin.publicKey, admin.publicKey, T22),
        ],
      }).compileToV0Message(),
    );
    tx.sign([admin, mint]);
    const signature = await connection().sendRawTransaction(tx.serialize());
    await connection().confirmTransaction({ ...latest, signature }, "confirmed");
    quote = mint.publicKey;
    await send([
      client.ix(
        "initialize",
        {
          roles: {
            market_admin: admin.publicKey,
            guardian: admin.publicKey,
            resolution_admin: admin.publicKey,
          },
        },
        {
          admin: admin.publicKey,
          config: client.config,
          quote_mint: quote,
          system_program: SystemProgram.programId,
        },
      ),
    ]);
    const xstock = await mockIssuerInstructions({
      connection: connection(),
      payer: admin.publicKey,
      authority: admin.publicKey,
      profile: "xstocks",
      ticker: "NVDA",
    });
    issuer = xstock.mint.publicKey;
    await send(xstock.instructions, admin, [xstock.mint]);
    await send([
      client.ix(
        "configure",
        {
          roles: {
            market_admin: admin.publicKey,
            guardian: admin.publicKey,
            resolution_admin: admin.publicKey,
          },
          maker_bps: 10,
          taker_bps: 20,
        },
        { admin: admin.publicKey, config: client.config },
      ),
    ]);
    // Only the quote pool is created directly; base pools are created (with
    // exact issuer admission) by the admin listing flow.
    await send([client.initializePool(quote, admin.publicKey, T22)]);
    for (let i = 0; i < 2; i++) {
      const id = digest(`pool-market-${i}-${admin.publicKey}`),
        m = marketAddress(client.config, id),
        uri = "ipfs://pool-test";
      await send([
        client.ix(
          "create_market",
          {
            id: [...id],
            terms: {
              condition: [...digest("event")],
              yes_index: 1,
              no_index: 2,
              rules_hash: [...digest("rules")],
              metadata_hash: [...digest(uri)],
              metadata_uri: uri,
              trading_open: bn(0),
              trading_cutoff: bn(Math.floor(Date.now() / 1000) + 3600),
              share_decimals: 6,
              tick: bn(10n ** 18n),
              // One step delivers >= 2 raw units of every leg (add_base rule).
              step: bn(2),
              min_notional: bn(1),
              max_quantity: bn(1_000_000),
              max_order: bn(10_000_000),
              max_wallet: bn(100_000_000),
              max_market: bn(1_000_000_000),
            },
          },
          {
            admin: admin.publicKey,
            config: client.config,
            quote_mint: quote,
            quote_pool: pool(quote),
            quote_vault: vault(quote),
            market: m,
            system_program: SystemProgram.programId,
          },
        ),
      ]);
      for (const tx of await initializeMarketVaults(
        client,
        m.toBase58(),
        admin.publicKey.toBase58(),
        (i === 0 ? [base] : [issuer, base]).map(String),
      ))
        await send(unwrap(tx));
      await send([
        client.ix(
          "lifecycle",
          { action: 0, commitment: Array(32).fill(0) },
          { actor: admin.publicKey, config: client.config, market: m },
        ),
        client.initializeWallet(m, alice.publicKey, admin.publicKey),
        client.initializeWallet(m, bob.publicKey, admin.publicKey),
      ]);
      markets.push(m);
    }
    for (const owner of [alice, bob])
      for (const [i, mint] of [base, quote].entries()) {
        const program = programOf(mint);
        const ata = await getOrCreateAssociatedTokenAccount(
          connection(),
          admin,
          mint,
          owner.publicKey,
          false,
          "confirmed",
          undefined,
          program,
        );
        await mintTo(
          connection(),
          admin,
          mint,
          ata.address,
          admin,
          100_000n,
          [],
          undefined,
          program,
        );
        await send(
          [client.depositPool(owner.publicKey, mint, 2000n, program, i ? 1975n : 2000n)],
          owner,
        );
      }
  }, 120_000);

  test("issuer controls enter custody only with exact admission; other authority extensions stay rejected", async () => {
    async function mint(kind: "delegate" | "close") {
      const mint = Keypair.generate(),
        space = getMintLen([
          kind === "delegate" ? ExtensionType.PermanentDelegate : ExtensionType.MintCloseAuthority,
        ]);
      await send(
        [
          SystemProgram.createAccount({
            fromPubkey: admin.publicKey,
            newAccountPubkey: mint.publicKey,
            space,
            lamports: await connection().getMinimumBalanceForRentExemption(space),
            programId: T22,
          }),
          kind === "delegate"
            ? createInitializePermanentDelegateInstruction(mint.publicKey, admin.publicKey, T22)
            : createInitializeMintCloseAuthorityInstruction(mint.publicKey, admin.publicKey, T22),
          createInitializeMintInstruction(mint.publicKey, 6, admin.publicKey, null, T22),
        ],
        admin,
        [mint],
      );
      return mint.publicKey;
    }
    const delegated = await mint("delegate");
    // Not admitted, and a grant wider than the mint's controls, both fail closed.
    for (const admitted of [0, 3, 63])
      await expect(
        send([client.initializePool(delegated, admin.publicKey, T22, admitted)]),
      ).rejects.toThrow();
    expect(await connection().getAccountInfo(pool(delegated))).toBeNull();
    expect(await connection().getAccountInfo(vault(delegated))).toBeNull();
    // Exactly PermanentDelegate (bit 1): an explicit issuer trust decision.
    await send([client.initializePool(delegated, admin.publicKey, T22, 1)]);
    expect((await poolState(delegated)).admitted).toBe(1);
    // Non-issuer-control authority extensions remain rejected at any admission.
    const closable = await mint("close");
    for (const admitted of [0, 63])
      await expect(
        send([client.initializePool(closable, admin.publicKey, T22, admitted)]),
      ).rejects.toThrow();
    expect(await connection().getAccountInfo(pool(closable))).toBeNull();
    // Only the market administrator admits issuer controls.
    const other = await mint("delegate");
    await expect(
      send([client.initializePool(other, attacker.publicKey, T22, 1)], attacker),
    ).rejects.toThrow();
    // The listed xStocks replica pool admits exactly its six controls.
    expect((await poolState(issuer)).admitted).toBe(63);
  }, 60_000);
  test("one deposit is shared across markets; pool/credit initialization cannot reset or steal balances", async () => {
    expect(await available(base)).toBe(2000n);
    expect(await available(quote)).toBe(1975n);
    await send([client.initializeCredit(base, alice.publicKey, attacker.publicKey)], attacker);
    expect(await available(base)).toBe(2000n);
    await expect(
      send([client.initializePool(base, attacker.publicKey)], attacker),
    ).rejects.toThrow();
    // No per-market underlying vaults exist in the protocol-wide layout.
    for (const m of markets)
      for (let c = 0; c < COLLATERALS; c++)
        expect(await connection().getAccountInfo(vaultAddress(m, underlyingAsset(c)))).toBeNull();
    await invariant();
  }, 30_000);
  test("split in two markets cannot reuse committed collateral; merging makes it globally available", async () => {
    // The base mint is leg 1 of market A and leg 2 of market B.
    for (const [i, m] of markets.entries()) {
      await client.market(m);
      await send([client.position("split", m, alice.publicKey, LEGS[i]!, 800n)], alice);
    }
    expect(await available(base)).toBe(400n);
    const before = await state();
    await expect(
      send([client.position("split", markets[1]!, alice.publicKey, 2, 401n)], alice),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    await send([client.position("merge", markets[0]!, alice.publicKey, 1, 300n)], alice);
    expect(await available(base)).toBe(700n);
    await send([client.position("split", markets[1]!, alice.publicKey, 2, 500n)], alice);
    expect(await available(base)).toBe(200n);
    await invariant();
  }, 30_000);
  test("reservations in one market block spending in another; cancellation returns global balance", async () => {
    const o = order(markets[0]!, alice, 0, 900n);
    await place(o, alice);
    expect(await available(quote)).toBe(175n);
    const before = await state();
    await expect(place(order(markets[1]!, alice, 0, 100n), alice)).rejects.toThrow();
    expect(await state()).toEqual(before);
    await send([await client.cancel(new PublicKey(orderId(o)), alice.publicKey)], alice);
    expect(await available(quote)).toBe(1975n);
    await invariant();
  }, 30_000);
  test("cross-market matching moves no issuer tokens and charges no extra transfer fees", async () => {
    const balances = await Promise.all(
      [base, quote].map(
        async (m, i) =>
          (await getAccount(connection(), vault(m), "confirmed", i ? T22 : TOKEN_PROGRAM_ID))
            .amount,
      ),
    );
    const sell = order(markets[1]!, bob, 1, 50n);
    await place(sell, bob);
    const buy = order(markets[1]!, alice, 0, 50n, 3n * 10n ** 18n);
    await place(buy, alice, [sell]);
    expect(await available(quote)).toBe(1875n); // Reserve150, spend100, refund50.
    expect(await available(base, bob.publicKey)).toBe(1950n);
    expect(
      await Promise.all(
        [base, quote].map(
          async (m, i) =>
            (await getAccount(connection(), vault(m), "confirmed", i ? T22 : TOKEN_PROGRAM_ID))
              .amount,
        ),
      ),
    ).toEqual(balances);
    await invariant();
  }, 30_000);
  test("batch cancellation and IOC refunds cannot strand funds in a market wallet", async () => {
    const a = order(markets[0]!, alice, 1, 10n),
      b = order(markets[0]!, alice, 0, 10n);
    await place(a, alice);
    await place(b, alice);
    const before = [await available(base), await available(quote)];
    await send(
      [
        client.orderMaintenance(
          "cancel_orders",
          markets[0]!,
          alice.publicKey,
          [new PublicKey(orderId(a)), new PublicKey(orderId(b))],
          [underlyingAsset(1), underlyingAsset(0)],
        ),
      ],
      alice,
    );
    expect([await available(base), await available(quote)]).toEqual([
      before[0]! + 10n,
      before[1]! + 20n,
    ]);
    const ioc = { ...order(markets[1]!, alice, 0, 10n), tif: 1 };
    const balance = await available(quote);
    await place(ioc, alice);
    expect(await available(quote)).toBe(balance);
    await invariant();
  }, 30_000);
  test("unauthorized withdrawals, wrong pool/credit and missing refund accounts roll back", async () => {
    const before = await state();
    const ix = client.withdraw(markets[0]!, alice.publicKey, base, 3, 1n).at(-1)!;
    ix.keys[0]!.pubkey = attacker.publicKey;
    await expect(send([ix], attacker)).rejects.toThrow();
    const split = client.position("split", markets[0]!, alice.publicKey, 1, 2n);
    const creditIndex = split.keys.findIndex((k) => k.pubkey.equals(credit(base)));
    split.keys[creditIndex]!.pubkey = credit(base, bob.publicKey);
    await expect(send([split], alice)).rejects.toThrow();
    expect(await state()).toEqual(before);
    const o = order(markets[0]!, alice, 1, 2n);
    await place(o, alice);
    const cancel = await client.cancel(new PublicKey(orderId(o)), alice.publicKey);
    cancel.keys.pop();
    const reserved = await state();
    await expect(send([cancel], alice)).rejects.toThrow();
    expect(await state()).toEqual(reserved);
    await send([await client.cancel(new PublicKey(orderId(o)), alice.publicKey)], alice);
    await invariant();
  }, 30_000);
  test("withdraw only available collateral; Token-2022 fee minimum and issuer freeze stay atomic", async () => {
    const before = await state();
    await expect(
      send(
        client.withdraw(markets[1]!, alice.publicKey, base, 3, (await available(base)) + 1n),
        alice,
      ),
    ).rejects.toThrow();
    await expect(
      send(
        client.withdraw(markets[1]!, alice.publicKey, quote, 0, 100n, alice.publicKey, T22, 100n),
        alice,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    await freezeAccount(connection(), admin, vault(quote), quote, admin, [], undefined, T22);
    const frozen = await state();
    await expect(
      send(
        client.withdraw(markets[1]!, alice.publicKey, quote, 0, 100n, alice.publicKey, T22, 98n),
        alice,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(frozen);
    await thawAccount(connection(), admin, vault(quote), quote, admin, [], undefined, T22);
    const balance = await available(quote);
    await send(
      client.withdraw(markets[1]!, alice.publicKey, quote, 0, 100n, alice.publicKey, T22, 98n),
      alice,
    );
    expect(await available(quote)).toBe(balance - 100n);
    await invariant();
  }, 30_000);
  test("donations do not create user credit and deposit minimum failures leave no new liability", async () => {
    const ata = await getOrCreateAssociatedTokenAccount(connection(), admin, base, alice.publicKey);
    const liability = big((await poolState(base)).liability),
      free = await available(base);
    await send([createTransferInstruction(ata.address, vault(base), alice.publicKey, 10n)], alice);
    expect(big((await poolState(base)).liability)).toBe(liability);
    expect(await available(base)).toBe(free);
    const before = await state();
    await expect(
      send([client.deposit(markets[0]!, alice.publicKey, quote, 0, 100n, T22, 100n)], alice),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    await invariant();
  }, 30_000);
  test("a claim recipient without a prior collateral deposit can merge into a newly created global credit", async () => {
    const m = markets[1]!;
    expect(await client.assetCredit(base, carol.publicKey)).toBeNull();
    await send([client.initializeWallet(m, carol.publicKey, admin.publicKey)]);
    // Base claims of market B are collateral 2 (assets 7, 8).
    for (const asset of [claimAsset(2, 0), claimAsset(2, 1)])
      await send(
        [
          client.ix(
            "transfer_credit",
            { asset, amount: bn(10) },
            {
              owner: alice.publicKey,
              market: m,
              source: walletAddress(m, alice.publicKey),
              destination: walletAddress(m, carol.publicKey),
            },
          ),
        ],
        alice,
      );
    // Position instructions need the credit account; the idempotent initializer
    // is prepended exactly as the SDK transaction builders do.
    await send(
      [
        client.positionCredit(m, carol.publicKey, 2),
        client.position("merge", m, carol.publicKey, 2, 10n),
      ],
      carol,
    );
    expect(await available(base, carol.publicKey)).toBe(10n);
    expect((await client.wallet(m, carol.publicKey))!.balances.map(big)).toEqual(
      Array(12).fill(0n),
    );
    await invariant();
  }, 30_000);
  test("zero amounts, invalid minima, duplicate and readonly global credits reject atomically", async () => {
    const before = await state();
    for (const [amount, minimum] of [
      [0, 0],
      [10, 0],
      [10, 11],
    ] as const) {
      const ix = client.deposit(markets[0]!, alice.publicKey, base, 3, 1n);
      ix.data = coder.instruction.encode("deposit_pool", {
        amount: bn(amount),
        minimum_credit: bn(minimum),
      });
      await expect(send([ix], alice)).rejects.toThrow();
    }
    const o = order(markets[1]!, alice, 0, 2n),
      m = await client.market(markets[1]!);
    const plan = planOrder({
      order: o,
      candidates: [],
      now: BigInt(Math.floor(Date.now() / 1000)),
      step: 2n,
      program: client.program,
      nextSequence: big(m.sequence[0]!),
      makerFeeBps: 10,
      takerFeeBps: 20,
    });
    for (const attack of ["duplicate", "readonly", "wrong-mint"] as const) {
      const ix = client.placement(o, plan, m);
      if (attack === "duplicate") ix.keys.push({ ...ix.keys.at(-1)! });
      else if (attack === "readonly") ix.keys.at(-1)!.isWritable = false;
      else ix.keys.at(-1)!.pubkey = credit(base);
      await expect(send([ix], alice)).rejects.toThrow();
    }
    expect(await state()).toEqual(before);
    await invariant();
  }, 30_000);
  test("one base pool backs leg 1 of market A and leg 2 of market B; an issuer pool is isolated per mint", async () => {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection(),
      admin,
      issuer,
      alice.publicKey,
      false,
      "confirmed",
      undefined,
      T22,
    );
    await mintTo(connection(), admin, issuer, ata.address, admin, 10n ** 10n, [], undefined, T22);
    await send([client.depositPool(alice.publicKey, issuer, 10n ** 9n, T22)], alice);
    const bobBase = await available(base, bob.publicKey),
      aliceIssuer = await available(issuer);
    // One deposit funds asks on the base mint in both markets, at different leg positions.
    const askA = order(markets[0]!, bob, 1, 10n),
      askB = order(markets[1]!, bob, 1, 10n);
    expect([askA.bases, askB.bases]).toEqual([legBit(1), legBit(2)]);
    await place(askA, bob);
    await place(askB, bob);
    expect(await available(base, bob.publicKey)).toBe(bobBase - 20n);
    const [a, b] = await Promise.all(markets.map((m) => client.market(m)));
    expect(big(a!.escrow[underlyingAsset(1)]!)).toBeGreaterThanOrEqual(10n);
    expect(big(b!.escrow[underlyingAsset(2)]!)).toBeGreaterThanOrEqual(10n);
    // The issuer leg of B (8 decimals, live ScaledUiAmount multiplier) converts
    // share units to raw issuer units; splits and reservations use its own pool.
    await send([client.position("split", markets[1]!, alice.publicKey, 1, 5000n)], alice);
    const leg = b!.legs[0]!;
    const askIssuer = order(markets[1]!, alice, 1, 2n, 2n * 10n ** 18n, 0, legBit(1));
    await place(askIssuer, alice);
    const reserved = big((await client.order(new PublicKey(orderId(askIssuer)))).reserved);
    expect(reserved).toBe(baseRaw(2n, big(leg.scale), big(leg.multiplier), true));
    expect(await available(issuer)).toBe(aliceIssuer - 5000n - reserved);
    expect(big((await poolState(issuer)).liability)).toBe(10n ** 9n);
    await invariant();
    for (const [o, owner] of [
      [askA, bob],
      [askB, bob],
      [askIssuer, alice],
    ] as const)
      await send([await client.cancel(new PublicKey(orderId(o)), owner.publicKey)], owner);
    await send([client.position("merge", markets[1]!, alice.publicKey, 1, 5000n)], alice);
    expect(await available(base, bob.publicKey)).toBe(bobBase);
    expect(await available(issuer)).toBe(aliceIssuer);
    await invariant();
  }, 60_000);
  test("resolution pays into global credit, which can fund a different still-open market", async () => {
    const m = markets[0]!,
      uri = "ipfs://resolution",
      evidence = digest(uri),
      commitment = resolutionHash(client.config, m, 1, 0, evidence, uri);
    for (const action of [1, 3])
      await send([
        client.ix(
          "lifecycle",
          { action, commitment: [...commitment] },
          { actor: admin.publicKey, config: client.config, market: m },
        ),
      ]);
    await send([
      client.ix(
        "resolve",
        { yes: 1, no: 0, evidence: [...evidence], uri },
        { actor: admin.publicKey, config: client.config, market: m, system_program: SystemProgram.programId },
      ),
    ]);
    const before = await available(base);
    await send([client.redeem(m, alice.publicKey, 1, 100n, 0n)], alice);
    expect(await available(base)).toBe(before + 100n);
    await send([client.position("split", markets[1]!, alice.publicKey, 2, 100n)], alice);
    expect(await available(base)).toBe(before);
    await invariant();
  }, 30_000);
  test("wrapped SOL uses a protocol-wide vault with exact raw-lamport deposits and withdrawals", async () => {
    await send([client.initializePool(NATIVE_MINT, admin.publicKey)]);
    const ata = await getOrCreateAssociatedTokenAccount(
      connection(),
      admin,
      NATIVE_MINT,
      alice.publicKey,
    );
    await send(
      [
        SystemProgram.transfer({
          fromPubkey: alice.publicKey,
          toPubkey: ata.address,
          lamports: 100_000_000,
        }),
        createSyncNativeInstruction(ata.address),
      ],
      alice,
    );
    await send([client.deposit(markets[0]!, alice.publicKey, NATIVE_MINT, 0, 100_000_000n)], alice);
    expect(await available(NATIVE_MINT)).toBe(100_000_000n);
    expect((await getAccount(connection(), vault(NATIVE_MINT))).amount).toBe(100_000_000n);
    await send(client.withdrawPool(alice.publicKey, NATIVE_MINT, 100_000_000n), alice);
    expect(await available(NATIVE_MINT)).toBe(0n);
    expect(big((await poolState(NATIVE_MINT)).liability)).toBe(0n);
    expect((await getAccount(connection(), vault(NATIVE_MINT))).amount).toBe(0n);
  }, 30_000);
});
