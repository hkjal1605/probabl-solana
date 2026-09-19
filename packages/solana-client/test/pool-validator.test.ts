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
  type OrderWire,
  type AssetPoolAccount,
} from "../src/index";
import { initializeMarketVaults } from "../src/admin";

const rpc = process.env.SOLANA_POOL_TEST_RPC;
describe.skipIf(!rpc)("protocol-wide custody on compiled Solana program", () => {
  const admin = Keypair.generate(),
    alice = Keypair.generate(),
    bob = Keypair.generate(),
    carol = Keypair.generate(),
    attacker = Keypair.generate();
  let client: SolanaClient, base: PublicKey, quote: PublicKey;
  const markets: PublicKey[] = [];
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
        ...[2, 3, 4, 5].flatMap((a) => [claimAddress(m, a), vaultAddress(m, a)]),
      ]),
    ];
    return (await connection().getMultipleAccountsInfo(keys)).map(
      (a) => a?.data.toString("base64") ?? null,
    );
  }
  async function invariant() {
    for (const [asset, mint] of [base, quote].entries()) {
      let liabilities = 0n;
      for (const owner of [alice, bob, carol])
        liabilities += await available(mint, owner.publicKey);
      for (const m of markets) {
        const market = await client.market(m);
        expect(big(market.credits[asset]!)).toBe(0n);
        liabilities += big(market.escrow[asset]!) + big(market.backing[asset]!);
        const yes = await getMint(connection(), market.mints[2 + asset * 2]!);
        const no = await getMint(connection(), market.mints[3 + asset * 2]!);
        const backing = big(market.backing[asset]!);
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
        for (const owner of [alice, bob])
          expect((await client.wallet(m, owner.publicKey))!.balances.slice(0, 2).map(big)).toEqual([
            0n,
            0n,
          ]);
      }
      expect(big((await poolState(mint)).liability)).toBe(liabilities);
      expect(
        (await getAccount(connection(), vault(mint), "confirmed", asset ? T22 : TOKEN_PROGRAM_ID))
          .amount >= liabilities,
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
    await send([
      client.initializePool(base, admin.publicKey),
      client.initializePool(quote, admin.publicKey, T22),
    ]);
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
              tick: bn(10n ** 18n),
              step: bn(1),
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
            base_mint: base,
            quote_mint: quote,
            market: m,
            system_program: SystemProgram.programId,
          },
        ),
      ]);
      for (const tx of await initializeMarketVaults(
        client,
        m.toBase58(),
        admin.publicKey.toBase58(),
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
        const program = i ? T22 : TOKEN_PROGRAM_ID;
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

  test("unsupported Token-2022 authority extensions cannot enter protocol custody", async () => {
    const mint = Keypair.generate(),
      space = getMintLen([ExtensionType.PermanentDelegate]);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: await connection().getMinimumBalanceForRentExemption(space),
          programId: T22,
        }),
        createInitializePermanentDelegateInstruction(mint.publicKey, admin.publicKey, T22),
        createInitializeMintInstruction(mint.publicKey, 6, admin.publicKey, null, T22),
      ],
      admin,
      [mint],
    );
    await expect(
      send([client.initializePool(mint.publicKey, admin.publicKey, T22)]),
    ).rejects.toThrow();
    expect(await connection().getAccountInfo(pool(mint.publicKey))).toBeNull();
    expect(await connection().getAccountInfo(vault(mint.publicKey))).toBeNull();
  }, 30_000);
  test("one deposit is shared across markets; pool/credit initialization cannot reset or steal balances", async () => {
    expect(await available(base)).toBe(2000n);
    expect(await available(quote)).toBe(1975n);
    await send([client.initializeCredit(base, alice.publicKey, attacker.publicKey)], attacker);
    expect(await available(base)).toBe(2000n);
    await expect(
      send([client.initializePool(base, attacker.publicKey)], attacker),
    ).rejects.toThrow();
    for (const m of markets)
      expect(await connection().getAccountInfo(vaultAddress(m, 0))).toBeNull();
    await invariant();
  }, 30_000);
  test("split in two markets cannot reuse committed collateral; merging makes it globally available", async () => {
    for (const m of markets) {
      await client.market(m);
      await send([client.position("split", m, alice.publicKey, 0, 800n)], alice);
    }
    expect(await available(base)).toBe(400n);
    const before = await state();
    await expect(
      send([client.position("split", markets[1]!, alice.publicKey, 0, 401n)], alice),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    await send([client.position("merge", markets[0]!, alice.publicKey, 0, 300n)], alice);
    expect(await available(base)).toBe(700n);
    await send([client.position("split", markets[1]!, alice.publicKey, 0, 500n)], alice);
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
          [0, 1],
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
    const ix = client.withdraw(markets[0]!, alice.publicKey, base, 0, 1n).at(-1)!;
    ix.keys[0]!.pubkey = attacker.publicKey;
    await expect(send([ix], attacker)).rejects.toThrow();
    const split = client.position("split", markets[0]!, alice.publicKey, 0, 1n);
    const creditIndex = split.keys.findIndex((k) => k.pubkey.equals(credit(base)));
    split.keys[creditIndex]!.pubkey = credit(base, bob.publicKey);
    await expect(send([split], alice)).rejects.toThrow();
    expect(await state()).toEqual(before);
    const o = order(markets[0]!, alice, 1, 1n);
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
        client.withdraw(markets[1]!, alice.publicKey, base, 0, (await available(base)) + 1n),
        alice,
      ),
    ).rejects.toThrow();
    await expect(
      send(
        client.withdraw(markets[1]!, alice.publicKey, quote, 1, 100n, alice.publicKey, T22, 100n),
        alice,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    await freezeAccount(connection(), admin, vault(quote), quote, admin, [], undefined, T22);
    const frozen = await state();
    await expect(
      send(
        client.withdraw(markets[1]!, alice.publicKey, quote, 1, 100n, alice.publicKey, T22, 98n),
        alice,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(frozen);
    await thawAccount(connection(), admin, vault(quote), quote, admin, [], undefined, T22);
    const balance = await available(quote);
    await send(
      client.withdraw(markets[1]!, alice.publicKey, quote, 1, 100n, alice.publicKey, T22, 98n),
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
      send([client.deposit(markets[0]!, alice.publicKey, quote, 1, 100n, T22, 100n)], alice),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    await invariant();
  }, 30_000);
  test("a claim recipient without a prior collateral deposit can merge into a newly created global credit", async () => {
    const m = markets[1]!;
    expect(await client.assetCredit(base, carol.publicKey)).toBeNull();
    await send([client.initializeWallet(m, carol.publicKey, admin.publicKey)]);
    for (const asset of [2, 3])
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
    await send([client.position("merge", m, carol.publicKey, 0, 10n)], carol);
    expect(await available(base, carol.publicKey)).toBe(10n);
    expect((await client.wallet(m, carol.publicKey))!.balances.map(big)).toEqual([
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
    ]);
    await invariant();
  }, 30_000);
  test("zero amounts, invalid minima, duplicate and readonly global credits reject atomically", async () => {
    const before = await state();
    for (const [amount, minimum] of [
      [0, 0],
      [10, 0],
      [10, 11],
    ] as const) {
      const ix = client.deposit(markets[0]!, alice.publicKey, base, 0, 1n);
      ix.data = coder.instruction.encode("deposit_pool", {
        amount: bn(amount),
        minimum_credit: bn(minimum),
      });
      await expect(send([ix], alice)).rejects.toThrow();
    }
    const o = order(markets[1]!, alice, 0, 1n),
      m = await client.market(markets[1]!);
    const plan = planOrder({
      order: o,
      candidates: [],
      now: BigInt(Math.floor(Date.now() / 1000)),
      step: 1n,
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
        { actor: admin.publicKey, config: client.config, market: m },
      ),
    ]);
    const before = await available(base);
    await send([client.redeem(m, alice.publicKey, 0, 100n, 0n)], alice);
    expect(await available(base)).toBe(before + 100n);
    await send([client.position("split", markets[1]!, alice.publicKey, 0, 100n)], alice);
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
