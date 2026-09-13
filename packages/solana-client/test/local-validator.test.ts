import { describe, test, expect, beforeAll } from "bun:test";
import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  createBurnInstruction,
  createTransferInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  SolanaClient,
  key,
  configAddress,
  marketAddress,
  walletAddress,
  vaultAddress,
  claimAddress,
  digest,
  bn,
  big,
  hex,
  orderId,
  planOrder,
  resolutionHash,
  traderAddress,
  unwrap,
  envelope,
  type TraderAccount,
  type OrderWire,
  type MarketAccount,
} from "../src/index.ts";
import { assertMarketInvariants } from "./validator-invariants.ts";

const rpc = process.env.SOLANA_TEST_RPC;
describe.skipIf(!rpc)("compiled Solana program on local validator", () => {
  const connection = new Connection(
    rpc ?? "http://127.0.0.1:8899",
    "confirmed",
  );
  const admin = Keypair.generate(),
    alice = Keypair.generate(),
    bob = Keypair.generate(),
    attacker = Keypair.generate();
  let client: SolanaClient;
  let base: ReturnType<typeof marketAddress>,
    quoteMint: ReturnType<typeof marketAddress>;
  let serial = 0;

  async function send(
    ixs: TransactionInstruction[],
    payer = admin,
    others: Keypair[] = [],
  ): Promise<void> {
    const latest = await connection.getLatestBlockhash();
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: ixs,
      }).compileToV0Message(),
    );
    transaction.sign([payer, ...others]);
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: true,
        maxRetries: 2,
      },
    );
    const result = await connection.confirmTransaction(
      { signature, ...latest },
      "confirmed",
    );
    if (result.value.err) {
      const detail = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      throw new Error(
        JSON.stringify(result.value.err) +
          " " +
          detail?.meta?.logMessages?.join("\n"),
      );
    }
  }

  beforeAll(async () => {
    for (const signer of [admin, alice, bob, attacker]) {
      const signature = await connection.requestAirdrop(
        signer.publicKey,
        20_000_000_000,
      );
      await connection.confirmTransaction(signature, "confirmed");
    }
    base = await createMint(connection, admin, admin.publicKey, null, 6);
    quoteMint = await createMint(connection, admin, admin.publicKey, null, 6);
    client = new SolanaClient({
      rpcUrl: rpc!,
      config: configAddress(admin.publicKey).toBase58(),
      genesisHash: await connection.getGenesisHash(),
    });
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
          quote_mint: quoteMint,
          system_program: SystemProgram.programId,
        },
      ),
    ]);
    for (const signer of [alice, bob])
      for (const mint of [base, quoteMint]) {
        const ata = await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          mint,
          signer.publicKey,
        );
        await mintTo(
          connection,
          admin,
          mint,
          ata.address,
          admin,
          1_000_000_000n,
        );
      }
  }, 60_000);

  async function fixture(
    overrides: Record<string, ReturnType<typeof bn>> = {},
    underlying = base,
  ) {
    const id = digest(`validator:${admin.publicKey}:${serial++}`),
      market = marketAddress(client.config, id);
    const now = Math.floor(Date.now() / 1000),
      uri = "ipfs://test-market";
    const terms = {
      condition: [...digest("external condition")],
      yes_index: 1,
      no_index: 2,
      rules_hash: [...digest("rules")],
      metadata_hash: [...digest(uri)],
      metadata_uri: uri,
      trading_open: bn(now - 10),
      trading_cutoff: bn(now + 3600),
      tick: bn(10n ** 18n),
      step: bn(1),
      min_notional: bn(1),
      max_quantity: bn(1_000_000_000),
      max_order: bn(1_000_000_000_000n),
      max_wallet: bn(2_000_000_000_000n),
      max_market: bn(4_000_000_000_000n),
      ...overrides,
    };
    await send([
      client.ix(
        "create_market",
        { id: [...id], terms },
        {
          admin: admin.publicKey,
          config: client.config,
          base_mint: underlying,
          quote_mint: quoteMint,
          market,
          system_program: SystemProgram.programId,
        },
      ),
    ]);
    for (let asset = 0; asset < 6; asset++)
      await send([
        client.ix(
          asset < 2 ? "initialize_asset" : "initialize_claim",
          { asset },
          {
            payer: admin.publicKey,
            market,
            mint:
              asset < 2
                ? [underlying, quoteMint][asset]!
                : claimAddress(market, asset),
            vault: vaultAddress(market, asset),
            token_program: TOKEN_PROGRAM_ID,
            system_program: SystemProgram.programId,
          },
        ),
      ]);
    for (const signer of [alice, bob])
      await send([
        client.initializeWallet(market, signer.publicKey, admin.publicKey),
      ]);
    await send([
      client.ix(
        "lifecycle",
        { action: 0, commitment: [...new Uint8Array(32)] },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    await send(
      [client.deposit(market, alice.publicKey, underlying, 0, 100n)],
      alice,
    );
    await send(
      [client.deposit(market, bob.publicKey, quoteMint, 1, 1_000n)],
      bob,
    );
    return market;
  }
  const order = (
    market: ReturnType<typeof marketAddress>,
    owner: Keypair,
    side: number,
    funding: number,
    branch: number,
    quantity = 100,
  ): OrderWire => ({
    marketId: market.toBase58(),
    maker: owner.publicKey.toBase58(),
    recipient: owner.publicKey.toBase58(),
    salt: hex(digest(`order:${serial++}`)),
    quantity: String(quantity),
    limitPriceRawX18: String(BigInt(side === 0 ? 6 : 5) * 10n ** 18n),
    expiry: String(Math.floor(Date.now() / 1000) + 1800),
    nonce: "0",
    maxFeeBps: 1_000,
    branch,
    side,
    fundingKind: funding,
    tif: side === 0 ? 1 : 0,
  });
  async function place(
    o: OrderWire,
    owner: Keypair,
    candidates: Parameters<typeof planOrder>[0]["candidates"] = [],
  ) {
    const market = await client.market(key(o.marketId));
    const config = await client.configAccount();
    const plan = planOrder({
      order: o,
      candidates,
      now: BigInt(Math.floor(Date.now() / 1000)),
      step: 1n,
      nextSequence: big(market.sequence[o.branch]!),
      makerFeeBps: config.maker_bps,
      takerFeeBps: config.taker_bps,
    });
    await send([client.placement(o, plan)], owner);
    return plan;
  }

  for (const branch of [0, 1])
    for (const sellFunding of [0, 1])
      for (const buyFunding of [0, 1]) {
        test(`branch ${branch}: seller funding ${sellFunding}, buyer funding ${buyFunding}; escrow, fees, recovery and redemption`, async () => {
          const market = await fixture();
          if (sellFunding)
            await send(
              [client.position("split", market, alice.publicKey, 0, 100n)],
              alice,
            );
          if (buyFunding)
            await send(
              [client.position("split", market, bob.publicKey, 1, 1_000n)],
              bob,
            );
          const ask = order(market, alice, 1, sellFunding, branch),
            bid = order(market, bob, 0, buyFunding, branch, 50);
          await place(ask, alice);
          await assertMarketInvariants(
            client,
            market,
            [alice.publicKey, bob.publicKey],
            [key(orderId(ask))],
          );
          await place(bid, bob, [
            {
              order: ask,
              orderHash: orderId(ask),
              remaining: 100n,
              sequence: 0n,
            },
          ]);
          const audit = () =>
            assertMarketInvariants(
              client,
              market,
              [alice.publicKey, bob.publicKey],
              [key(orderId(ask)), key(orderId(bid))],
            );
          await audit();
          const buyer = await client.wallet(market, bob.publicKey),
            seller = await client.wallet(market, alice.publicKey);
          expect(big(buyer!.balances[2 + branch]!)).toBe(50n);
          expect(big(seller!.balances[4 + branch]!)).toBe(250n);
          expect(big(buyer!.balances[buyFunding ? 4 + branch : 1]!)).toBe(750n);
          const askKey = key(orderId(ask));
          expect(big((await client.order(askKey)).remaining)).toBe(50n);
          const before = (await connection.getAccountInfo(market))!.data;
          await expect(
            send([await client.cancel(askKey, attacker.publicKey)], attacker),
          ).rejects.toThrow();
          expect(
            (await connection.getAccountInfo(market))!.data.equals(before),
          ).toBe(true);
          // Pause never traps recoverable escrow, complete sets or credited assets.
          await send([
            client.ix(
              "pause",
              { paused: true, reason: [...digest("pause")] },
              { guardian: admin.publicKey, config: client.config },
            ),
          ]);
          await send([await client.cancel(askKey, alice.publicKey)], alice);
          await audit();
          const cancelled = await client.order(askKey);
          expect(cancelled.status).toBe(3);
          expect(big(cancelled.filled)).toBe(50n);
          expect(big(cancelled.remaining)).toBe(0n);
          await send(
            client.withdraw(
              market,
              bob.publicKey,
              claimAddress(market, 2 + branch),
              2 + branch,
              50n,
            ),
            bob,
          );
          expect(
            (
              await getAccount(
                connection,
                getAssociatedTokenAddressSync(
                  claimAddress(market, 2 + branch),
                  bob.publicKey,
                ),
              )
            ).amount,
          ).toBe(50n);
          await audit();
          await send(
            [
              client.deposit(
                market,
                bob.publicKey,
                claimAddress(market, 2 + branch),
                2 + branch,
                50n,
              ),
            ],
            bob,
          );
          await send([
            client.ix(
              "lifecycle",
              { action: 1, commitment: [...digest("freeze")] },
              { actor: admin.publicKey, config: client.config, market },
            ),
          ]);
          const yes = branch === 0 ? 1 : 0,
            no = 1 - yes,
            evidence = digest("evidence"),
            uri = "ipfs://resolution";
          const commitment = resolutionHash(
            client.config,
            market,
            yes,
            no,
            evidence,
            uri,
          );
          await send([
            client.ix(
              "lifecycle",
              { action: 3, commitment: [...commitment] },
              { actor: admin.publicKey, config: client.config, market },
            ),
          ]);
          await expect(
            send([
              client.ix(
                "resolve",
                { yes, no, evidence: [...evidence], uri: uri + "wrong" },
                { actor: admin.publicKey, config: client.config, market },
              ),
            ]),
          ).rejects.toThrow();
          await send([
            client.ix(
              "resolve",
              { yes, no, evidence: [...evidence], uri },
              { actor: admin.publicKey, config: client.config, market },
            ),
          ]);
          await expect(
            send([
              client.ix(
                "resolve",
                { yes, no, evidence: [...evidence], uri },
                { actor: admin.publicKey, config: client.config, market },
              ),
            ]),
          ).rejects.toThrow();
          await send(
            [client.position("redeem", market, bob.publicKey, 0, 50n, branch)],
            bob,
          );
          await audit();
          expect(
            big((await client.wallet(market, bob.publicKey))!.balances[0]!),
          ).toBe(50n);
          const state = await client.market(market);
          expect(big(state.open_notional)).toBe(0n);
          for (let asset = 0; asset < 6; asset++) {
            const actual = (
              await getAccount(connection, vaultAddress(market, asset))
            ).amount;
            const liability =
              big(state.credits[asset]!) +
              big(state.escrow[asset]!) +
              big(asset < 2 ? state.backing[asset]! : state.fees[asset - 2]!);
            expect(actual).toBeGreaterThanOrEqual(liability);
          }
          await send([
            client.ix(
              "pause",
              { paused: false, reason: [...digest("resume")] },
              { guardian: admin.publicKey, config: client.config },
            ),
          ]);
        }, 90_000);
      }

  test("reject substituted vault/mint, duplicate accounts, stale guards, replay, fee caps and IOC escrow retention", async () => {
    const market = await fixture(),
      ask = order(market, alice, 1, 0, 0),
      empty = planOrder({
        order: ask,
        candidates: [],
        now: BigInt(Math.floor(Date.now() / 1000)),
        step: 1n,
        nextSequence: 0n,
        makerFeeBps: 0,
        takerFeeBps: 0,
      });
    const good = client.placement(ask, empty),
      before = (await connection.getAccountInfo(market))!.data;
    const duplicate = client.placement(ask, empty);
    duplicate.keys[9] = duplicate.keys[8]!;
    await expect(send([duplicate], alice)).rejects.toThrow();
    const foreign = client.placement(ask, empty);
    foreign.keys[8] = { ...foreign.keys[8]!, pubkey: base };
    await expect(send([foreign], alice)).rejects.toThrow();
    const unsigned = client.placement(ask, empty);
    unsigned.keys[0] = { ...unsigned.keys[0]!, isSigner: false };
    await expect(send([unsigned], attacker)).rejects.toThrow();
    expect((await connection.getAccountInfo(market))!.data.equals(before)).toBe(
      true,
    );
    await send([good], alice);
    await expect(send([good], alice)).rejects.toThrow();
    const bid = order(market, bob, 0, 0, 0, 50),
      plan = planOrder({
        order: bid,
        candidates: [
          {
            order: ask,
            orderHash: orderId(ask),
            remaining: 100n,
            sequence: 0n,
          },
        ],
        now: BigInt(Math.floor(Date.now() / 1000)),
        step: 1n,
        nextSequence: 1n,
        makerFeeBps: 0,
        takerFeeBps: 0,
      });
    const stale = { ...plan, guard: { ...plan.guard, nextSequence: "0" } };
    await expect(send([client.placement(bid, stale)], bob)).rejects.toThrow();
    const wrongRemainder = { ...plan, expectedRemaining: ["99"] };
    await expect(
      send([client.placement(bid, wrongRemainder)], bob),
    ).rejects.toThrow();
    const cfg = await client.configAccount();
    await send([
      client.ix(
        "configure",
        { roles: cfg.roles, maker_bps: 100, taker_bps: 200 },
        { admin: admin.publicKey, config: client.config },
      ),
    ]);
    await expect(send([client.placement(bid, plan)], bob)).rejects.toThrow();
    const updated = {
      ...plan,
      guard: { ...plan.guard, makerFeeBps: 100, takerFeeBps: 200 },
    };
    await send([client.placement(bid, updated)], bob);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[2]!),
    ).toBe(49n);
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[4]!),
    ).toBe(248n);
    const state: MarketAccount = await client.market(market);
    expect(state.fees.map(big)).toEqual([1n, 0n, 2n, 0n]);
    await expect(
      send(
        [
          client.ix(
            "claim_fees",
            { asset: 2, amount: bn(1) },
            {
              admin: attacker.publicKey,
              config: client.config,
              market,
              destination: walletAddress(market, bob.publicKey),
            },
          ),
        ],
        attacker,
      ),
    ).rejects.toThrow();
    const collect = (amount: number) =>
      client.ix(
        "claim_fees",
        { asset: 2, amount: bn(amount) },
        {
          admin: admin.publicKey,
          config: client.config,
          market,
          destination: walletAddress(market, bob.publicKey),
        },
      );
    await expect(send([collect(2)])).rejects.toThrow();
    await send([collect(1)]);
    await assertMarketInvariants(
      client,
      market,
      [alice.publicKey, bob.publicKey],
      [key(orderId(ask)), key(orderId(bid))],
    );
    expect(big((await client.market(market)).fees[0]!)).toBe(0n);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[2]!),
    ).toBe(50n);
    await expect(send([collect(1)])).rejects.toThrow();
    const transfer = client.ix(
      "transfer_credit",
      { asset: 2, amount: bn(7) },
      {
        owner: bob.publicKey,
        market,
        source: walletAddress(market, bob.publicKey),
        destination: walletAddress(market, alice.publicKey),
      },
    );
    const unauthorizedTransfer = client.ix(
      "transfer_credit",
      { asset: 2, amount: bn(7) },
      {
        owner: attacker.publicKey,
        market,
        source: walletAddress(market, bob.publicKey),
        destination: walletAddress(market, alice.publicKey),
      },
    );
    await expect(send([unauthorizedTransfer], attacker)).rejects.toThrow();
    await send([transfer], bob);
    await assertMarketInvariants(
      client,
      market,
      [alice.publicKey, bob.publicKey],
      [key(orderId(ask)), key(orderId(bid))],
    );
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[2]!),
    ).toBe(7n);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[2]!),
    ).toBe(43n);
    await send([
      client.ix(
        "configure",
        { roles: cfg.roles, maker_bps: 0, taker_bps: 0 },
        { admin: admin.publicKey, config: client.config },
      ),
    ]);
    const ioc = { ...order(market, bob, 0, 0, 1, 10), tif: 1 };
    const balanceBefore = big(
      (await client.wallet(market, bob.publicKey))!.balances[1]!,
    );
    await place(ioc, bob);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[1]!),
    ).toBe(balanceBefore);
    expect((await client.order(key(orderId(ioc)))).status).toBe(3);
    expect(big((await client.order(key(orderId(ioc)))).filled)).toBe(0n);
  }, 90_000);
  test("whole-funded multi-maker settlement accumulates every claim supply delta", async () => {
    const market = await fixture();
    const first = order(market, alice, 1, 0, 0, 2);
    const second = order(market, alice, 1, 0, 0, 3);
    await place(first, alice);
    await place(second, alice);
    const bid = order(market, bob, 0, 0, 0, 5);
    const state = await client.market(market);
    const plan = planOrder({
      order: bid,
      now: BigInt(Math.floor(Date.now() / 1000)),
      step: 1n,
      nextSequence: big(state.sequence[0]!),
      makerFeeBps: 0,
      takerFeeBps: 0,
      candidates: [
        {
          order: first,
          orderHash: orderId(first),
          remaining: 2n,
          sequence: 0n,
        },
        {
          order: second,
          orderHash: orderId(second),
          remaining: 3n,
          sequence: 1n,
        },
      ],
    });
    const built = await client.prepareTransaction(
      bob.publicKey,
      envelope([client.placement(bid, plan)]),
    );
    built.transaction.sign([bob]);
    const signature = await connection.sendRawTransaction(
      built.transaction.serialize(),
    );
    const result = await connection.confirmTransaction(
      {
        signature,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
      },
      "confirmed",
    );
    expect(result.value.err).toBeNull();
    const detail = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(detail!.meta!.computeUnitsConsumed!).toBeLessThan(400_000);
    expect(plan.makers).toHaveLength(2);
    expect((await client.market(market)).backing.map(big)).toEqual([5n, 25n]);
    for (const [offset, supply] of [5n, 25n].entries())
      for (const branch of [0, 1])
        expect(
          (
            await getMint(
              connection,
              claimAddress(market, 2 + offset * 2 + branch),
            )
          ).supply,
        ).toBe(supply);
    await assertMarketInvariants(
      client,
      market,
      [alice.publicKey, bob.publicKey],
      [first, second, bid].map((o) => key(orderId(o))),
    );
  }, 90_000);

  test("self-trades and a shared non-owner recipient preserve aggregate credits", async () => {
    const market = await fixture();
    await send(
      [client.deposit(market, alice.publicKey, quoteMint, 1, 500n)],
      alice,
    );
    const ask = {
        ...order(market, alice, 1, 0, 0),
        recipient: bob.publicKey.toBase58(),
      },
      bid = {
        ...order(market, alice, 0, 0, 0, 50),
        recipient: bob.publicKey.toBase58(),
      };
    await place(ask, alice);
    await place(bid, alice, [
      { order: ask, orderHash: orderId(ask), remaining: 100n, sequence: 0n },
    ]);
    const a = await client.wallet(market, alice.publicKey),
      b = await client.wallet(market, bob.publicKey);
    expect(a!.balances.map(big)).toEqual([0n, 250n, 0n, 50n, 0n, 250n]);
    expect(b!.balances.map(big)).toEqual([0n, 1000n, 50n, 0n, 250n, 0n]);
    expect(big((await client.order(key(orderId(ask)))).filled)).toBe(50n);
    await send(
      [await client.cancel(key(orderId(ask)), alice.publicKey)],
      alice,
    );
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(50n);
  }, 90_000);

  test("final-state caps roll back earlier token CPIs; IOC releases its remainder before checking caps", async () => {
    const market = await fixture({
      max_order: bn(160),
      max_wallet: bn(160),
      max_market: bn(160),
    });
    const ask = order(market, alice, 1, 0, 0, 10),
      other = order(market, alice, 1, 0, 1, 20);
    await place(ask, alice);
    await place(other, alice);
    const bid = {
      ...order(market, bob, 0, 0, 0, 20),
      limitPriceRawX18: String(8n * 10n ** 18n),
      tif: 0,
    };
    const accounts = [
      market,
      walletAddress(market, alice.publicKey),
      walletAddress(market, bob.publicKey),
      key(orderId(ask)),
      ...Array.from({ length: 6 }, (_, asset) => vaultAddress(market, asset)),
      ...Array.from({ length: 4 }, (_, i) => claimAddress(market, i + 2)),
    ];
    const before = await connection.getMultipleAccountsInfo(accounts);
    const candidates = [
      { order: ask, orderHash: orderId(ask), remaining: 10n, sequence: 0n },
    ];
    await expect(place(bid, bob, candidates)).rejects.toThrow();
    const after = await connection.getMultipleAccountsInfo(accounts);
    expect(after.map((a) => a!.data.toString("base64"))).toEqual(
      before.map((a) => a!.data.toString("base64")),
    );
    expect(await connection.getAccountInfo(key(orderId(bid)))).toBeNull();
    await place({ ...bid, tif: 1 }, bob, candidates);
    const filled = await client.order(key(orderId(bid)));
    expect(big(filled.filled)).toBe(10n);
    expect(filled.status).toBe(3);
    expect(big(filled.reserved)).toBe(0n);
    expect(big((await client.market(market)).open_notional)).toBe(100n);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[1]!),
    ).toBe(950n);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[2]!),
    ).toBe(10n);
  }, 90_000);

  test("INVALID rejects fractional burns and combines odd pairs exactly after archival", async () => {
    const market = await fixture();
    await send(
      [client.position("split", market, alice.publicKey, 0, 9n)],
      alice,
    );
    await expect(
      send(
        [client.position("redeem", market, alice.publicKey, 0, 1n, 0)],
        alice,
      ),
    ).rejects.toThrow();
    const evidence = digest("invalid proof"),
      uri = "ipfs://invalid",
      commitment = resolutionHash(client.config, market, 1, 1, evidence, uri);
    await send([
      client.ix(
        "lifecycle",
        { action: 1, commitment: [...digest("freeze")] },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "lifecycle",
        { action: 3, commitment: [...commitment] },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "resolve",
        { yes: 1, no: 1, evidence: [...evidence], uri },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    await send([
      client.ix(
        "lifecycle",
        { action: 4, commitment: [...digest("archive")] },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    await send(
      [client.position("merge", market, alice.publicKey, 0, 7n)],
      alice,
    );
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(98n);
    const protectedAccounts = [
      market,
      walletAddress(market, alice.publicKey),
      claimAddress(market, 2),
      claimAddress(market, 3),
      vaultAddress(market, 2),
      vaultAddress(market, 3),
    ];
    const snapshot = async () =>
      (await connection.getMultipleAccountsInfo(protectedAccounts)).map((a) =>
        a!.data.toString("base64"),
      );
    const beforeOdd = await snapshot();
    await expect(
      send(
        [client.position("redeem", market, alice.publicKey, 0, 1n, 0)],
        alice,
      ),
    ).rejects.toThrow("6018");
    expect(await snapshot()).toEqual(beforeOdd);
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(98n);
    await send([client.redeem(market, alice.publicKey, 0, 1n, 1n)], alice);
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(99n);
    expect(big((await client.market(market)).backing[0]!)).toBe(1n);
    await send(
      [client.position("merge", market, alice.publicKey, 0, 1n)],
      alice,
    );
    expect(
      (await client.wallet(market, alice.publicKey))!.balances
        .slice(2, 4)
        .map(big),
    ).toEqual([0n, 0n]);
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(100n);
    expect(big((await client.market(market)).backing[0]!)).toBe(0n);
    // All nine complete sets recovered exactly: no newly stranded backing dust.
    const state = await client.market(market);
    expect(state.fees.map(big)).toEqual([0n, 0n, 0n, 0n]);
    for (let asset = 0; asset < 6; asset++)
      expect(
        (await getAccount(connection, vaultAddress(market, asset))).amount,
      ).toBe(
        big(state.credits[asset]!) +
          big(state.escrow[asset]!) +
          big(asset < 2 ? state.backing[asset]! : state.fees[asset - 2]!),
      );
  }, 90_000);

  test("exact recovery handles zero-decimal external claims and preserves a reusable odd remainder", async () => {
    const indivisible = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      0,
    );
    const funding = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      indivisible,
      alice.publicKey,
    );
    await mintTo(connection, admin, indivisible, funding.address, admin, 100n);
    const market = await fixture({}, indivisible);
    await send(
      [client.position("split", market, alice.publicKey, 0, 9n)],
      alice,
    );
    const yesMint = claimAddress(market, 2),
      noMint = claimAddress(market, 3);
    await send(
      await client.withdrawCredit(market, alice.publicKey, yesMint, 2, 4n),
      alice,
    );
    await send(
      await client.withdrawCredit(market, alice.publicKey, noMint, 3, 7n),
      alice,
    );
    const aliceYes = getAssociatedTokenAddressSync(yesMint, alice.publicKey);
    const aliceNo = getAssociatedTokenAddressSync(noMint, alice.publicKey);
    const bobNo = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      noMint,
      bob.publicKey,
    );
    await send(
      [createTransferInstruction(aliceNo, bobNo.address, alice.publicKey, 7n)],
      alice,
    );
    const evidence = digest("exact-recovery"),
      uri = "ipfs://exact-recovery";
    await send([
      client.ix(
        "lifecycle",
        { action: 1, commitment: [...digest("freeze")] },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "lifecycle",
        {
          action: 3,
          commitment: [
            ...resolutionHash(client.config, market, 1, 1, evidence, uri),
          ],
        },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "resolve",
        { yes: 1, no: 1, evidence: [...evidence], uri },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    const recovery = await client.redemptionTransaction(
      market,
      alice.publicKey,
      0,
      9n,
      2n,
    );
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
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(96n);
    expect((await getAccount(connection, aliceYes)).amount).toBe(1n);
    expect((await getAccount(connection, bobNo.address)).amount).toBe(7n);
    const audit = () =>
      assertMarketInvariants(client, market, [alice.publicKey, bob.publicKey]);
    await audit();
    const protectedAccounts = [
      market,
      walletAddress(market, alice.publicKey),
      aliceYes,
    ];
    const snapshot = async () =>
      (await connection.getMultipleAccountsInfo(protectedAccounts)).map((a) =>
        a!.data.toString("base64"),
      );
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      const odd = await client.redemptionTransaction(
        market,
        alice.publicKey,
        0,
        1n,
        0n,
      );
      expect(odd.executable).toBe(false);
      expect(odd.recovery.retainedYes).toBe(1n);
      expect(() => unwrap(odd)).toThrow();
    }
    expect(await snapshot()).toEqual(before);
    // The retained claim remains transferable/combinable, not a discarded IOU.
    await send(
      [createTransferInstruction(bobNo.address, aliceNo, bob.publicKey, 1n)],
      bob,
    );
    await send(
      unwrap(
        await client.redemptionTransaction(market, alice.publicKey, 0, 1n, 1n),
      ),
      alice,
    );
    await send(
      unwrap(
        await client.redemptionTransaction(market, bob.publicKey, 0, 0n, 6n),
      ),
      bob,
    );
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(97n);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[0]!),
    ).toBe(3n);
    expect((await client.market(market)).backing.map(big)).toEqual([0n, 0n]);
    expect((await getMint(connection, yesMint)).supply).toBe(0n);
    expect((await getMint(connection, noMint)).supply).toBe(0n);
    await audit();
  }, 90_000);

  for (const payouts of [
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    test(`audit stateful conservation through external claims, burns, resolution ${payouts} and archive`, async () => {
      const market = await fixture();
      const owners = [alice.publicKey, bob.publicKey];
      const audit = () => assertMarketInvariants(client, market, owners);
      await send(
        [client.deposit(market, alice.publicKey, quoteMint, 1, 1_000n)],
        alice,
      );
      await send([client.deposit(market, bob.publicKey, base, 0, 100n)], bob);
      await send(
        [client.position("split", market, alice.publicKey, 0, 40n)],
        alice,
      );
      await send(
        [client.position("split", market, bob.publicKey, 1, 400n)],
        bob,
      );
      await audit();

      // Total mint supply must include external holders, and voluntary burns
      // may only create surplus backing, never credits to an unrelated wallet.
      const mint = claimAddress(market, 2);
      await send(client.withdraw(market, alice.publicKey, mint, 2, 11n), alice);
      await audit();
      const bobAta = await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        mint,
        bob.publicKey,
      );
      await send(
        [
          createTransferInstruction(
            getAssociatedTokenAddressSync(mint, alice.publicKey),
            bobAta.address,
            alice.publicKey,
            4n,
          ),
        ],
        alice,
      );
      await audit();
      await send([client.deposit(market, bob.publicKey, mint, 2, 3n)], bob);
      await audit();
      const beforeBurn = await client.market(market);
      const supplyBefore = (await getMint(connection, mint)).supply;
      await send(
        [createBurnInstruction(bobAta.address, mint, bob.publicKey, 1n)],
        bob,
      );
      expect((await getMint(connection, mint)).supply).toBe(supplyBefore - 1n);
      expect((await client.market(market)).backing.map(big)).toEqual(
        beforeBurn.backing.map(big),
      );
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
          const uri = "ipfs://comparative-audit",
            evidence = digest("audit evidence");
          await send([
            client.ix(
              "lifecycle",
              { action: 1, commitment: [...digest("audit freeze")] },
              { actor: admin.publicKey, config: client.config, market },
            ),
            client.ix(
              "lifecycle",
              {
                action: 3,
                commitment: [
                  ...resolutionHash(
                    client.config,
                    market,
                    payouts[0],
                    payouts[1],
                    evidence,
                    uri,
                  ),
                ],
              },
              { actor: admin.publicKey, config: client.config, market },
            ),
            client.ix(
              "resolve",
              { yes: payouts[0], no: payouts[1], evidence: [...evidence], uri },
              { actor: admin.publicKey, config: client.config, market },
            ),
          ]);
          await audit();
        }
        if (step === 24) {
          await send([
            client.ix(
              "lifecycle",
              { action: 4, commitment: [...digest("audit archive")] },
              { actor: admin.publicKey, config: client.config, market },
            ),
          ]);
          await audit();
        }
        const owner = next() % 2 === 0 ? alice : bob;
        const other = owner === alice ? bob : alice;
        const collateral = next() % 2,
          i = 2 + 2 * collateral;
        const balances = (await client.wallet(
          market,
          owner.publicKey,
        ))!.balances.map(big);
        const min = (...values: bigint[]) =>
          values.reduce((a, b) => (a < b ? a : b));
        const wanted = BigInt((next() % 9) + 1);
        const action = step % 4;
        if (action === 0 || (action === 3 && step < 16)) {
          const amount = min(balances[collateral]!, wanted);
          if (amount > 0n) {
            await send(
              [
                client.position(
                  "split",
                  market,
                  owner.publicKey,
                  collateral,
                  amount,
                ),
              ],
              owner,
            );
            actions[0]!++;
          }
        } else if (action === 1) {
          const amount = min(balances[i]!, balances[i + 1]!, wanted);
          if (amount > 0n) {
            await send(
              [
                client.position(
                  "merge",
                  market,
                  owner.publicKey,
                  collateral,
                  amount,
                ),
              ],
              owner,
            );
            actions[1]!++;
          }
        } else if (action === 2) {
          const amount = min(balances[i]!, wanted);
          if (amount > 0n) {
            await send(
              [
                client.ix(
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
                client.ix(
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
                    underlying_vault: vaultAddress(market, collateral),
                  },
                ),
              ],
              owner,
            );
            const denominator = BigInt(payouts[0] + payouts[1]);
            const expected =
              (yes * BigInt(payouts[0]) + no * BigInt(payouts[1])) /
              denominator;
            expect(
              big(
                (await client.wallet(market, owner.publicKey))!.balances[
                  collateral
                ]!,
              ),
            ).toBe(balances[collateral]! + expected);
            actions[3]!++;
          }
        }
        await audit();
      }
      expect(actions.every((count) => count > 0)).toBe(true);

      const beforeDonation = (await connection.getAccountInfo(market))!.data;
      await send(
        [
          createTransferInstruction(
            getAssociatedTokenAddressSync(base, alice.publicKey),
            vaultAddress(market, 0),
            alice.publicKey,
            2n,
          ),
        ],
        alice,
      );
      expect(
        (await connection.getAccountInfo(market))!.data.equals(beforeDonation),
      ).toBe(true);
      await audit();
      // Paused, archived complete-set recovery is intentionally different from MetaDAO.
      await send([
        client.ix(
          "pause",
          { paused: true, reason: [...digest("audit pause")] },
          { guardian: admin.publicKey, config: client.config },
        ),
      ]);
      const beforeRecovery = (await client.wallet(
        market,
        alice.publicKey,
      ))!.balances.map(big);
      await send(
        [client.position("split", market, alice.publicKey, 0, 3n)],
        alice,
      );
      await audit();
      await send(
        [client.position("merge", market, alice.publicKey, 0, 3n)],
        alice,
      );
      expect(
        (await client.wallet(market, alice.publicKey))!.balances.map(big),
      ).toEqual(beforeRecovery);
      await audit();
      await send([
        client.ix(
          "pause",
          { paused: false, reason: [...digest("audit resume")] },
          { guardian: admin.publicKey, config: client.config },
        ),
      ]);
    }, 180_000);
  }

  test("audit position account attacks and repeated redemption leave no partial state", async () => {
    const market = await fixture(),
      foreign = await fixture();
    await send(
      [client.position("split", market, alice.publicKey, 0, 11n)],
      alice,
    );
    const accounts = [
      market,
      walletAddress(market, alice.publicKey),
      walletAddress(market, bob.publicKey),
      ...Array.from({ length: 6 }, (_, i) => vaultAddress(market, i)),
      ...Array.from({ length: 4 }, (_, i) => claimAddress(market, i + 2)),
    ];
    const snapshot = async () =>
      (await connection.getMultipleAccountsInfo(accounts)).map((a) =>
        a!.data.toString("base64"),
      );
    const attacks: TransactionInstruction[] = [];
    for (const [index, pubkey] of [
      [2, walletAddress(market, bob.publicKey)],
      [3, claimAddress(foreign, 2)],
      [4, claimAddress(market, 2)],
      [5, vaultAddress(foreign, 2)],
      [6, vaultAddress(market, 2)],
      [7, TOKEN_2022_PROGRAM_ID],
      [8, vaultAddress(foreign, 0)],
    ] as const) {
      const ix = client.position("merge", market, alice.publicKey, 0, 1n);
      ix.keys[index] = { ...ix.keys[index]!, pubkey };
      attacks.push(ix);
    }
    attacks.push(client.position("split", market, alice.publicKey, 0, 0n));
    attacks.push(client.position("merge", market, alice.publicKey, 0, 12n));
    attacks.push(client.position("redeem", market, alice.publicKey, 0, 1n, 0));
    attacks.push(
      createMintToInstruction(
        claimAddress(market, 2),
        vaultAddress(market, 2),
        alice.publicKey,
        1n,
      ),
    );
    for (const ix of attacks) {
      const before = await snapshot();
      await expect(send([ix], alice)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
    // Positive control proves valid accounts and available balances still work.
    await send(
      [client.position("merge", market, alice.publicKey, 0, 1n)],
      alice,
    );
    const uri = "ipfs://audit-replay",
      evidence = digest("replay evidence");
    await send([
      client.ix(
        "lifecycle",
        { action: 1, commitment: [...digest("freeze")] },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "lifecycle",
        {
          action: 3,
          commitment: [
            ...resolutionHash(client.config, market, 1, 0, evidence, uri),
          ],
        },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "resolve",
        { yes: 1, no: 0, evidence: [...evidence], uri },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    const redeem = client.position(
      "redeem",
      market,
      alice.publicKey,
      0,
      10n,
      0,
    );
    await send([redeem], alice);
    const before = await snapshot();
    // Different payer makes this a distinct transaction, not a cached signature.
    await expect(send([redeem], admin, [alice])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await assertMarketInvariants(client, market, [
      alice.publicKey,
      bob.publicKey,
    ]);
  }, 120_000);

  test("audit u64 supply overflow rolls back the first mint CPI and preserves recovery", async () => {
    const maximum = (1n << 64n) - 1n;
    const mint = await createMint(connection, admin, admin.publicKey, null, 0);
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      alice.publicKey,
    );
    await mintTo(connection, admin, mint, ata.address, admin, maximum);
    const market = await fixture({}, mint);
    const audit = () =>
      assertMarketInvariants(client, market, [alice.publicKey, bob.publicKey]);
    await send(
      [client.deposit(market, alice.publicKey, mint, 0, maximum - 100n)],
      alice,
    );
    await send(
      [client.position("split", market, alice.publicKey, 0, maximum)],
      alice,
    );
    await audit();
    const uri = "ipfs://audit-u64",
      evidence = digest("u64 evidence");
    await send([
      client.ix(
        "lifecycle",
        { action: 1, commitment: [...digest("freeze")] },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "lifecycle",
        {
          action: 3,
          commitment: [
            ...resolutionHash(client.config, market, 1, 0, evidence, uri),
          ],
        },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "resolve",
        { yes: 1, no: 0, evidence: [...evidence], uri },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    await send(
      [client.position("redeem", market, alice.publicKey, 0, maximum, 0)],
      alice,
    );
    await audit();
    const accounts = [
      market,
      walletAddress(market, alice.publicKey),
      claimAddress(market, 2),
      claimAddress(market, 3),
      vaultAddress(market, 2),
      vaultAddress(market, 3),
    ];
    const snapshot = async () =>
      (await connection.getMultipleAccountsInfo(accounts)).map((a) =>
        a!.data.toString("base64"),
      );
    const before = await snapshot();
    // YES minting can succeed, but the outstanding losing NO supply is already
    // u64::MAX. Failure of the second CPI must undo the first mint and credits.
    await expect(
      send([client.position("split", market, alice.publicKey, 0, 1n)], alice),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect((await getMint(connection, claimAddress(market, 2))).supply).toBe(
      0n,
    );
    expect((await getMint(connection, claimAddress(market, 3))).supply).toBe(
      maximum,
    );
    await send(
      client.withdraw(market, alice.publicKey, mint, 0, maximum),
      alice,
    );
    expect((await getAccount(connection, ata.address)).amount).toBe(maximum);
    await audit();
    await send(
      [client.position("redeem", market, alice.publicKey, 0, maximum, 1)],
      alice,
    );
    await audit();
  }, 90_000);

  test("audit wrapped SOL collateral uses raw lamports and exact split/merge/redemption", async () => {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      NATIVE_MINT,
      alice.publicKey,
    );
    await send(
      [
        SystemProgram.transfer({
          fromPubkey: alice.publicKey,
          toPubkey: ata.address,
          lamports: 10_000,
        }),
        createSyncNativeInstruction(ata.address),
      ],
      alice,
    );
    const market = await fixture({}, NATIVE_MINT);
    const audit = () =>
      assertMarketInvariants(client, market, [alice.publicKey, bob.publicKey]);
    expect(
      (await getAccount(connection, vaultAddress(market, 0))).isNative,
    ).toBe(true);
    expect((await getMint(connection, claimAddress(market, 2))).decimals).toBe(
      9,
    );
    await audit();
    await send(
      [client.position("split", market, alice.publicKey, 0, 99n)],
      alice,
    );
    await audit();
    await send(
      [client.position("merge", market, alice.publicKey, 0, 39n)],
      alice,
    );
    await audit();
    const uri = "ipfs://audit-wsol",
      evidence = digest("wsol evidence");
    await send([
      client.ix(
        "lifecycle",
        { action: 1, commitment: [...digest("freeze")] },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "lifecycle",
        {
          action: 3,
          commitment: [
            ...resolutionHash(client.config, market, 0, 1, evidence, uri),
          ],
        },
        { actor: admin.publicKey, config: client.config, market },
      ),
      client.ix(
        "resolve",
        { yes: 0, no: 1, evidence: [...evidence], uri },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    await send(
      [client.position("redeem", market, alice.publicKey, 0, 60n, 1)],
      alice,
    );
    await audit();
    await send(
      client.withdraw(market, alice.publicKey, NATIVE_MINT, 0, 100n),
      alice,
    );
    expect(
      big((await client.wallet(market, alice.publicKey))!.balances[0]!),
    ).toBe(0n);
    expect((await getAccount(connection, vaultAddress(market, 0))).amount).toBe(
      0n,
    );
    await audit();
  }, 90_000);

  test("owner-wide nonce invalidation spans markets and is never reset by wallet initialization", async () => {
    const markets = [await fixture(), await fixture()],
      asks = markets.map((m) => order(m, alice, 1, 0, 0));
    for (const ask of asks) await place(ask, alice);
    const trader = traderAddress(client.config, alice.publicKey);
    await expect(
      send(
        [
          client.ix(
            "invalidate_nonce",
            { minimum: bn(1) },
            { owner: attacker.publicKey, trader },
          ),
        ],
        attacker,
      ),
    ).rejects.toThrow();
    await send(
      [
        client.ix(
          "invalidate_nonce",
          { minimum: bn(1) },
          { owner: alice.publicKey, trader },
        ),
      ],
      alice,
    );
    for (let i = 0; i < markets.length; i++) {
      const bid = order(markets[i]!, bob, 0, 0, 0, 10),
        ask = asks[i]!;
      await expect(
        place(bid, bob, [
          {
            order: ask,
            orderHash: orderId(ask),
            remaining: 100n,
            sequence: 0n,
          },
        ]),
      ).rejects.toThrow();
      // Stale makers can be released by anyone, but only to the original owner's credit.
      await send(
        [await client.cancel(key(orderId(ask)), attacker.publicKey)],
        attacker,
      );
      expect(
        big((await client.wallet(markets[i]!, alice.publicKey))!.balances[0]!),
      ).toBe(100n);
    }
    const third = await fixture();
    expect(
      big((await client.fetch<TraderAccount>("Trader", trader)).minimum_nonce),
    ).toBe(1n);
    await expect(place(order(third, alice, 1, 0, 0), alice)).rejects.toThrow();
    await place({ ...order(third, alice, 1, 0, 0), nonce: "1" }, alice);
    await expect(
      send(
        [
          client.ix(
            "invalidate_nonce",
            { minimum: bn(1) },
            { owner: alice.publicKey, trader },
          ),
        ],
        alice,
      ),
    ).rejects.toThrow();
  }, 90_000);
});
