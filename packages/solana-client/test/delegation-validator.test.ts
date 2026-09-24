import { beforeAll, describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  SolanaClient,
  configAddress,
  marketAddress,
  walletAddress,
  traderAddress,
  poolAddress,
  poolVaultAddress,
  claimAddress,
  vaultAddress,
  delegationAddress,
  assetCreditAddress,
  bn,
  big,
  digest,
  coder,
  unwrap,
  planOrder,
  orderId,
  orderWire,
  orderSalt,
  budgetedInstructions,
  baseRaw,
  type OrderWire,
  type TraderAccount,
  type DelegateLimits,
} from "../src/index";
import { initializeMarketVaults } from "../src/admin";
import { mockIssuerInstructions } from "../../../scripts/solana/mock-issuers.ts";
import { decodeSnapshot, liveOrder } from "../../../services/solana-indexer/src/projection";

const rpc = process.env.SOLANA_DELEGATION_TEST_RPC;
describe.skipIf(!rpc)("trading-only delegation on compiled Solana program", () => {
  const admin = Keypair.generate(),
    alice = Keypair.generate(),
    bob = Keypair.generate(),
    attacker = Keypair.generate();
  let client: SolanaClient,
    base: PublicKey,
    issuer: PublicKey,
    quote: PublicKey,
    table: AddressLookupTableAccount | undefined;
  const markets: PublicKey[] = [];
  let serial = 0;
  const connection = () => client.connection;
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  async function send(ixs: TransactionInstruction[], payer = admin, others: Keypair[] = []) {
    const latest = await connection().getLatestBlockhash();
    const instructions = budgetedInstructions(ixs, client.program);
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions,
      }).compileToV0Message(table ? [table] : []),
    );
    tx.sign([payer, ...others]);
    try {
      const signature = await connection().sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      const result = await connection().confirmTransaction({ ...latest, signature }, "confirmed");
      if (result.value.err) throw new Error(JSON.stringify(result.value.err));
      return signature;
    } catch (e) {
      const error = e as { message?: string; logs?: string[] };
      throw new Error(`${error.message ?? String(e)}\n${error.logs?.join("\n") ?? ""}`);
    }
  }
  async function fund(keypair: Keypair) {
    await connection().confirmTransaction(
      await connection().requestAirdrop(keypair.publicKey, 2_000_000_000),
      "confirmed",
    );
  }
  async function approve(overrides: Partial<DelegateLimits> = {}, owner = alice) {
    const delegate = Keypair.generate();
    await fund(delegate);
    const limits: DelegateLimits = {
      market: null,
      expiresAt: now() + 3600n,
      maxOrderQuote: 1000n,
      totalQuote: 10_000n,
      maxFeeBps: 50,
      permissions: 3,
      ...overrides,
    };
    await send([client.approveDelegate(owner.publicKey, delegate.publicKey, limits)], owner);
    return { delegate, limits, owner };
  }
  async function order(
    owner = alice,
    delegate?: Keypair,
    changes: Partial<OrderWire> = {},
  ): Promise<OrderWire> {
    const trader = await client.fetch<TraderAccount>(
      "Trader",
      traderAddress(client.config, owner.publicKey),
    );
    const nonce = big(trader.minimum_nonce);
    return {
      maker: owner.publicKey.toBase58(),
      recipient: owner.publicKey.toBase58(),
      ...(delegate ? { delegate: delegate.publicKey.toBase58() } : {}),
      marketId: markets[0]!.toBase58(),
      salt: orderSalt(nonce, digest(`delegated-${serial++}`)),
      quantity: "10",
      limitPriceRawX18: String(2n * 10n ** 18n),
      expiry: String(now() + 1800n),
      nonce: String(nonce),
      branch: 0,
      side: 0,
      tif: 0,
      fundingKind: 0,
      maxFeeBps: 50,
      bases: 1,
      ...changes,
    };
  }
  async function placement(o: OrderWire, makers: OrderWire[] = []) {
    const m = await client.market(new PublicKey(o.marketId));
    const candidates = await Promise.all(
      makers.map(async (wire) => {
        const a = await client.order(new PublicKey(orderId(wire)));
        return {
          order: orderWire(a),
          orderHash: orderId(wire),
          remaining: big(a.remaining),
          sequence: big(a.sequence),
        };
      }),
    );
    const plan = planOrder({
      order: o,
      candidates,
      now: now(),
      step: big(m.terms.step),
      nextSequence: big(m.sequence[o.branch]!),
      makerFeeBps: 0,
      takerFeeBps: 0,
      program: client.program,
    });
    return client.placement(o, plan, m);
  }
  async function available(mint: PublicKey, owner = alice.publicKey) {
    return big((await client.assetCredit(mint, owner))!.available);
  }
  async function image(keys: PublicKey[]) {
    return (await connection().getMultipleAccountsInfo(keys)).map(
      (a) => a?.data.toString("base64") ?? null,
    );
  }
  const grantKey = (delegate: Keypair, owner = alice.publicKey) =>
    delegationAddress(client.config, owner, delegate.publicKey);

  beforeAll(async () => {
    if (!rpc || !["localhost", "127.0.0.1"].includes(new URL(rpc).hostname))
      throw new Error("Disposable localhost only");
    client = new SolanaClient({
      rpcUrl: rpc,
      config: configAddress(admin.publicKey).toBase58(),
      genesisHash: "local",
    });
    for (const signer of [admin, alice, bob, attacker])
      await connection().confirmTransaction(
        await connection().requestAirdrop(signer.publicKey, 20_000_000_000),
        "confirmed",
      );
    base = await createMint(connection(), admin, admin.publicKey, null, 6);
    quote = await createMint(connection(), admin, admin.publicKey, null, 6);
    // Ondo-configured mock issuer (Token-2022 issuer controls, 9 decimals, live multiplier).
    const ondo = await mockIssuerInstructions({
      connection: connection(),
      payer: admin.publicKey,
      authority: admin.publicKey,
      profile: "ondo",
      ticker: "NVDA",
    });
    issuer = ondo.mint.publicKey;
    {
      // Token-2022 setup only: no protocol compute profile applies.
      const latest = await connection().getLatestBlockhash();
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: admin.publicKey,
          recentBlockhash: latest.blockhash,
          instructions: ondo.instructions,
        }).compileToV0Message(),
      );
      tx.sign([admin, ondo.mint]);
      const signature = await connection().sendRawTransaction(tx.serialize());
      await connection().confirmTransaction({ ...latest, signature }, "confirmed");
    }
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
      client.initializePool(quote, admin.publicKey, TOKEN_PROGRAM_ID, 0),
    ]);
    // Two single-leg markets plus one market listing [base, issuer].
    for (let i = 0; i < 3; i++) {
      const id = digest(`delegate-market-${i}-${admin.publicKey}`),
        m = marketAddress(client.config, id),
        uri = "ipfs://delegate-test";
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
              trading_cutoff: bn(now() + 7200n),
              share_decimals: 6,
              tick: bn(10n ** 18n),
              // One step must deliver at least two raw units of every leg.
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
            quote_pool: poolAddress(client.config, quote),
            quote_vault: poolVaultAddress(poolAddress(client.config, quote)),
            market: m,
            system_program: SystemProgram.programId,
          },
        ),
      ]);
      for (const tx of await initializeMarketVaults(
        client,
        m.toBase58(),
        admin.publicKey.toBase58(),
        i === 2 ? [base.toBase58(), issuer.toBase58()] : [base.toBase58()],
      ))
        await send(unwrap(tx));
      await send([
        client.ix(
          "lifecycle",
          { action: 0, commitment: Array(32).fill(0) },
          { actor: admin.publicKey, config: client.config, market: m },
        ),
      ]);
      for (const owner of [alice, bob])
        await send([client.initializeWallet(m, owner.publicKey, admin.publicKey)]);
      markets.push(m);
    }
    for (const owner of [alice, bob])
      for (const mint of [base, quote]) {
        const ata = await getOrCreateAssociatedTokenAccount(
          connection(),
          admin,
          mint,
          owner.publicKey,
        );
        await mintTo(connection(), admin, mint, ata.address, admin, 1_000_000n);
        await send([client.depositPool(owner.publicKey, mint, 100_000n)], owner);
      }
    for (const owner of [alice, bob]) {
      const ata = await getOrCreateAssociatedTokenAccount(
        connection(),
        admin,
        issuer,
        owner.publicKey,
        false,
        "confirmed",
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      await mintTo(
        connection(),
        admin,
        issuer,
        ata.address,
        admin,
        10n ** 12n,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      await send(
        [client.depositPool(owner.publicKey, issuer, 10n ** 11n, TOKEN_2022_PROGRAM_ID)],
        owner,
      );
    }
    // Compress only public test addresses; no production table or key is used.
    const [create, address] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey,
      payer: admin.publicKey,
      recentSlot: await connection().getSlot("finalized"),
    });
    await send([create]);
    const addresses = [
      client.config,
      base,
      quote,
      issuer,
      TOKEN_PROGRAM_ID,
      ...[base, quote, issuer].flatMap((mint) => {
        const pool = poolAddress(client.config, mint);
        return [
          pool,
          poolVaultAddress(pool),
          ...[alice, bob].map((o) => assetCreditAddress(pool, o.publicKey)),
        ];
      }),
      ...markets.flatMap((m) => [
        m,
        ...[1, 2, 4, 5, 7, 8].flatMap((a) => [claimAddress(m, a), vaultAddress(m, a)]),
        ...[alice, bob].flatMap((o) => [
          walletAddress(m, o.publicKey),
          traderAddress(client.config, o.publicKey),
        ]),
      ]),
    ];
    const unique = [...new Map(addresses.map((a) => [a.toBase58(), a])).values()];
    for (let i = 0; i < unique.length; i += 20)
      await send([
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: address,
          authority: admin.publicKey,
          payer: admin.publicKey,
          addresses: unique.slice(i, i + 20),
        }),
      ]);
    await send([
      AddressLookupTableProgram.freezeLookupTable({
        lookupTable: address,
        authority: admin.publicKey,
      }),
    ]);
    // The RPC forwards transactions only once their lookup table is rooted.
    const extended = await connection().getSlot("confirmed");
    while ((await connection().getSlot("finalized")) <= extended) await Bun.sleep(200);
    table = (await connection().getAddressLookupTable(address, { commitment: "finalized" })).value!;
  }, 120_000);

  test("owner approval creates an immutable scoped capability; delegate-only signatures trade owner balances", async () => {
    const { delegate } = await approve();
    const o = await order(alice, delegate);
    const ownerSol = await connection().getBalance(alice.publicKey),
      before = await available(quote);
    await send([await placement(o)], delegate);
    const placed = await client.order(new PublicKey(orderId(o)));
    expect(placed.owner.equals(alice.publicKey)).toBe(true);
    expect(placed.delegate.equals(delegate.publicKey)).toBe(true);
    expect(placed.terms.recipient.equals(alice.publicKey)).toBe(true);
    expect(await available(quote)).toBe(before - 20n);
    expect(await connection().getBalance(alice.publicKey)).toBe(ownerSol);
    expect(
      big((await client.delegation(alice.publicKey, delegate.publicKey)).remaining_quote),
    ).toBe(9980n);
    await send([await client.cancel(new PublicKey(orderId(o)), delegate.publicKey)], delegate);
    expect(await available(quote)).toBe(before);
    expect(
      big((await client.delegation(alice.publicKey, delegate.publicKey)).remaining_quote),
    ).toBe(9980n);
    const next = await order(alice, delegate, { marketId: markets[1]!.toBase58() });
    await send([await placement(next)], delegate);
    await send([await client.cancel(new PublicKey(orderId(next)), alice.publicKey)], alice);
  }, 30_000);

  test("maker fills validate the grant and credit only the beneficial owner's conditional positions", async () => {
    const { delegate } = await approve({ maxOrderQuote: 20n, totalQuote: 20n });
    const sell = await order(alice, delegate, { side: 1 });
    await send([await placement(sell)], delegate);
    expect(
      big((await client.delegation(alice.publicKey, delegate.publicKey)).remaining_quote),
    ).toBe(0n);
    const before = await client.wallet(markets[0]!, alice.publicKey);
    const buy = await order(bob);
    await send([await placement(buy, [sell])], bob);
    expect((await client.order(new PublicKey(orderId(sell)))).status).toBe(2);
    const after = await client.wallet(markets[0]!, alice.publicKey);
    // Quote YES (asset 1) for the fill; leg-1 NO (asset 5) from the split underlying.
    expect(big(after!.balances[1]!) - big(before!.balances[1]!)).toBe(20n);
    expect(big(after!.balances[5]!) - big(before!.balances[5]!)).toBe(10n);
    expect(await client.wallet(markets[0]!, delegate.publicKey)).toBeNull();
    expect(await client.assetCredit(quote, delegate.publicKey)).toBeNull();
  }, 30_000);

  test("revocation blocks signed new orders and resting fills immediately; anyone can release reservations", async () => {
    const { delegate, limits } = await approve();
    const sell = await order(alice, delegate, { side: 1 });
    const starting = await available(base);
    await send([await placement(sell)], delegate);
    const pending = await placement(await order(alice, delegate));
    const recent = await connection().getLatestBlockhash();
    const signedBeforeRevocation = new VersionedTransaction(
      new TransactionMessage({
        payerKey: delegate.publicKey,
        recentBlockhash: recent.blockhash,
        instructions: budgetedInstructions([pending], client.program),
      }).compileToV0Message([table!]),
    );
    signedBeforeRevocation.sign([delegate]);
    await send([client.revokeDelegate(alice.publicKey, delegate.publicKey)], alice);
    const before = await image([
      grantKey(delegate),
      markets[0]!,
      walletAddress(markets[0]!, alice.publicKey),
      new PublicKey(orderId(sell)),
    ]);
    await expect(send([pending], delegate)).rejects.toThrow("DelegationInactive");
    await expect(
      connection().sendRawTransaction(signedBeforeRevocation.serialize(), { skipPreflight: false }),
    ).rejects.toThrow("DelegationInactive");
    // A maker whose grant was revoked is skipped: an immediate-or-cancel taker
    // left with nothing to fill fails as stale, touching nothing.
    await expect(send([await placement(await order(bob, undefined, { tif: 1 }), [sell])], bob)).rejects.toThrow(
      "StalePlan",
    );
    expect(
      await image([
        grantKey(delegate),
        markets[0]!,
        walletAddress(markets[0]!, alice.publicKey),
        new PublicKey(orderId(sell)),
      ]),
    ).toEqual(before);
    await expect(
      send([client.approveDelegate(alice.publicKey, delegate.publicKey, limits)], alice),
    ).rejects.toThrow();
    await send([await client.cancel(new PublicKey(orderId(sell)), attacker.publicKey)], attacker);
    expect(await available(base)).toBe(starting);
    await send([client.revokeDelegate(alice.publicKey, delegate.publicKey)], alice); // idempotent, never deletes state
  }, 30_000);

  test("global revocation invalidates every old key without cancelling owner orders or resetting on wallet initialization", async () => {
    const a = await approve(),
      b = await approve();
    const ownerOrder = await order(alice, undefined, { side: 1 });
    await send([await placement(ownerOrder)], alice);
    const resting = await order(alice, a.delegate, { side: 1 });
    await send([await placement(resting)], a.delegate);
    await send([client.revokeAllDelegates(alice.publicKey)], alice);
    for (const { delegate } of [a, b])
      await expect(send([await placement(await order(alice, delegate))], delegate)).rejects.toThrow(
        "DelegationInactive",
      );
    await expect(send([await placement(await order(bob, undefined, { tif: 1 }), [resting])], bob)).rejects.toThrow(
      "StalePlan",
    );
    // A resting taker simply rests instead of filling the invalidated maker.
    const rests = await order(bob);
    await send([await placement(rests, [resting])], bob);
    expect(big((await client.order(new PublicKey(orderId(rests)))).filled)).toBe(0n);
    expect(big((await client.order(new PublicKey(orderId(resting)))).filled)).toBe(0n);
    await send([await placement(await order(bob), [ownerOrder])], bob);
    await send(
      [await client.cancel(new PublicKey(orderId(resting)), attacker.publicKey)],
      attacker,
    );
    const fresh = await approve();
    await send([await placement(await order(alice, fresh.delegate, { tif: 1 }))], fresh.delegate);
    expect(big((await client.delegation(alice.publicKey, fresh.delegate.publicKey)).epoch)).toBe(
      1n,
    );
  }, 30_000);

  test("approval before the first market wallet works and later initialization preserves the global revocation epoch", async () => {
    const owner = Keypair.generate();
    await fund(owner);
    const first = await approve({}, owner);
    await send([client.revokeAllDelegates(owner.publicKey)], owner);
    await send([client.initializeWallet(markets[0]!, owner.publicKey, admin.publicKey)]);
    const trader = await client.fetch<TraderAccount>(
      "Trader",
      traderAddress(client.config, owner.publicKey),
    );
    expect(big(trader.delegation_epoch)).toBe(1n);
    expect(big((await client.delegation(owner.publicKey, first.delegate.publicKey)).epoch)).toBe(
      0n,
    );
    const second = await approve({}, owner);
    expect(big((await client.delegation(owner.publicKey, second.delegate.publicKey)).epoch)).toBe(
      1n,
    );
  }, 30_000);

  test("scope, per-order cap, fee cap, expiry and recipient changes reject without consuming funds or budget", async () => {
    const { delegate } = await approve({
      market: markets[0]!,
      maxOrderQuote: 20n,
      totalQuote: 40n,
    });
    const stateKeys = [
      grantKey(delegate),
      markets[0]!,
      markets[1]!,
      assetCreditAddress(poolAddress(client.config, quote), alice.publicKey),
    ];
    const before = await image(stateKeys);
    await expect(
      send(
        [await placement(await order(alice, delegate, { marketId: markets[1]!.toBase58() }))],
        delegate,
      ),
    ).rejects.toThrow("InvalidDelegation");
    await expect(
      send([await placement(await order(alice, delegate, { quantity: "12" }))], delegate),
    ).rejects.toThrow("DelegateBudget");
    for (const attack of ["recipient", "fees", "expiry", "salt"] as const) {
      const ix = await placement(await order(alice, delegate));
      const decoded = coder.instruction.decode(ix.data)!.data as any;
      if (attack === "recipient") decoded.terms.recipient = attacker.publicKey;
      if (attack === "fees") decoded.terms.max_fee_bps = 51;
      if (attack === "expiry") decoded.terms.expiry = bn(now() + 4000n);
      if (attack === "salt") {
        decoded.terms.salt = Array(32).fill(5);
        ix.keys[4]!.pubkey = new PublicKey(
          orderId({ ...(await order(alice)), salt: "0x" + "05".repeat(32) }),
        );
      }
      ix.data = coder.instruction.encode("place", decoded);
      await expect(send([ix], delegate)).rejects.toThrow("InvalidDelegation");
    }
    expect(await image(stateKeys)).toEqual(before);
  }, 30_000);

  test("lifetime turnover is not replenished by cancellation, and a failed placement rolls its debit back", async () => {
    const { delegate } = await approve({ maxOrderQuote: 20n, totalQuote: 40n });
    for (let i = 0; i < 2; i++) {
      const o = await order(alice, delegate);
      await send([await placement(o)], delegate);
      await send([await client.cancel(new PublicKey(orderId(o)), delegate.publicKey)], delegate);
    }
    await expect(send([await placement(await order(alice, delegate))], delegate)).rejects.toThrow(
      "DelegateBudget",
    );
    expect(
      big((await client.delegation(alice.publicKey, delegate.publicKey)).remaining_quote),
    ).toBe(0n);
    const fresh = await approve({ maxOrderQuote: 1_000_000n, totalQuote: 1_000_000n });
    await expect(
      send(
        [await placement(await order(alice, fresh.delegate, { quantity: "200000" }))],
        fresh.delegate,
      ),
    ).rejects.toThrow("InsufficientFunds");
    expect(
      big((await client.delegation(alice.publicKey, fresh.delegate.publicKey)).remaining_quote),
    ).toBe(1_000_000n);
  }, 30_000);

  test("delegated batches can cancel only their own orders; one foreign order rolls back the entire batch", async () => {
    const a = await approve(),
      b = await approve();
    const own = await order(alice, a.delegate),
      foreign = await order(alice, b.delegate);
    await send([await placement(own)], a.delegate);
    await send([await placement(foreign)], b.delegate);
    const keys = [own, foreign].map((o) => new PublicKey(orderId(o))),
      before = await image(keys);
    await expect(
      send(
        [
          client.orderMaintenance(
            "cancel_orders",
            markets[0]!,
            alice.publicKey,
            keys,
            [0],
            a.delegate.publicKey,
          ),
        ],
        a.delegate,
      ),
    ).rejects.toThrow("Unauthorized");
    expect(await image(keys)).toEqual(before);
    await send(
      [
        client.orderMaintenance(
          "cancel_orders",
          markets[0]!,
          alice.publicKey,
          [keys[0]!],
          [0],
          a.delegate.publicKey,
        ),
      ],
      a.delegate,
    );
    await send([await client.cancel(keys[1]!, alice.publicKey)], alice);
    const noCancel = await approve({ permissions: 1 }),
      o = await order(alice, noCancel.delegate);
    await send([await placement(o)], noCancel.delegate);
    await expect(
      send(
        [await client.cancel(new PublicKey(orderId(o)), noCancel.delegate.publicKey)],
        noCancel.delegate,
      ),
    ).rejects.toThrow("InvalidDelegation");
    await send([await client.cancel(new PublicKey(orderId(o)), alice.publicKey)], alice);
  }, 30_000);

  test("delegates cannot withdraw, transfer claims, change authority, invalidate owner nonces or reclaim owner's rent", async () => {
    const { delegate, limits } = await approve();
    await client.market(markets[0]!);
    const raw = (ix: TransactionInstruction) => {
      for (const meta of ix.keys) if (meta.pubkey.equals(alice.publicKey)) meta.isSigner = false;
      return ix;
    };
    const trader = traderAddress(client.config, alice.publicKey),
      before = await image([trader, grantKey(delegate)]);
    const attacks = [
      ...client.withdrawPool(alice.publicKey, quote, 1n, delegate.publicKey).slice(1),
      client.revokeDelegate(alice.publicKey, delegate.publicKey),
      client.revokeAllDelegates(alice.publicKey),
      client.invalidateNonce(alice.publicKey, 1n),
      client.ix(
        "transfer_credit",
        { asset: 4, amount: bn(1) },
        {
          owner: alice.publicKey,
          market: markets[0]!,
          source: walletAddress(markets[0]!, alice.publicKey),
          destination: walletAddress(markets[0]!, bob.publicKey),
        },
      ),
      ...client
        .withdraw(
          markets[0]!,
          alice.publicKey,
          claimAddress(markets[0]!, 4),
          4,
          1n,
          delegate.publicKey,
        )
        .slice(1),
      client.approveDelegate(alice.publicKey, Keypair.generate().publicKey, limits),
      client.position("split", markets[0]!, alice.publicKey, 0, 1n),
      client.position("merge", markets[0]!, alice.publicKey, 0, 1n),
      client.redeem(markets[0]!, alice.publicKey, 0, 1n, 0n),
    ];
    for (const ix of attacks)
      await expect(send([raw(ix)], delegate)).rejects.toThrow("AccountNotSigner");
    const o = await order(alice, delegate);
    await send([await placement(o)], delegate);
    const retire = client.orderMaintenance(
      "retire_orders",
      markets[0]!,
      alice.publicKey,
      [new PublicKey(orderId(o))],
      [0],
    );
    retire.keys[0]!.pubkey = delegate.publicKey;
    await expect(send([retire], delegate)).rejects.toThrow("Unauthorized");
    // Place consumed allowance, but permission and invalidation state cannot change.
    expect((await image([trader]))[0]).toBe(before[0]);
    expect((await client.delegation(alice.publicKey, delegate.publicKey)).revoked).toBe(false);
    await send([await client.cancel(new PublicKey(orderId(o)), alice.publicKey)], alice);
  }, 30_000);

  test("foreign-owner grants, absent grants and readonly taker grants cannot authorize trading", async () => {
    const good = await approve(),
      foreign = await approve({}, bob);
    for (const attack of ["missing", "foreign", "readonly", "signer"] as const) {
      const ix = await placement(await order(alice, good.delegate));
      if (attack === "missing") {
        ix.keys[9]!.pubkey = client.program;
        ix.keys[9]!.isWritable = false;
      }
      if (attack === "foreign") ix.keys[9]!.pubkey = grantKey(foreign.delegate, bob.publicKey);
      if (attack === "readonly") ix.keys[9]!.isWritable = false;
      if (attack === "signer") ix.keys[0]!.pubkey = attacker.publicKey;
      await expect(send([ix], attack === "signer" ? attacker : good.delegate)).rejects.toThrow();
    }
    expect(
      big((await client.delegation(alice.publicKey, good.delegate.publicKey)).remaining_quote),
    ).toBe(10_000n);
  }, 30_000);

  test("duplicate or omitted maker grants fail atomically; indexer hides revoked liquidity", async () => {
    const { delegate } = await approve();
    const sell = await order(alice, delegate, { side: 1 });
    await send([await placement(sell)], delegate);
    const taker = await order(bob, undefined, { tif: 1 }),
      original = await placement(taker, [sell]);
    const absent = await placement(taker, [sell]);
    absent.keys.pop();
    const duplicate = await placement(taker, [sell]);
    duplicate.keys.push({ ...duplicate.keys.at(-1)! });
    for (const ix of [absent, duplicate]) await expect(send([ix], bob)).rejects.toThrow();
    expect((await client.order(new PublicKey(orderId(sell)))).status).toBe(1);
    const getSnapshot = async () => {
      const response = await connection().getProgramAccounts(client.program, {
        withContext: true,
        commitment: "confirmed",
      });
      return decodeSnapshot(
        client,
        response.context.slot,
        response.value.map((a) => ({
          address: a.pubkey.toBase58(),
          data: a.account.data.toString("base64"),
        })),
      );
    };
    let snap = await getSnapshot();
    expect(liveOrder(snap.orders.get(orderId(sell))!, snap, now())).toBe(true);
    await send([client.revokeDelegate(alice.publicKey, delegate.publicKey)], alice);
    snap = await getSnapshot();
    expect(liveOrder(snap.orders.get(orderId(sell))!, snap, now())).toBe(false);
    // The revoked maker is skipped; the IOC taker then has nothing to fill.
    await expect(send([original], bob)).rejects.toThrow("StalePlan");
    await send([await client.cancel(new PublicKey(orderId(sell)), attacker.publicKey)], attacker);
  }, 30_000);

  test("expired capability cannot place or fill, and its balance can still be recovered", async () => {
    const { delegate, limits } = await approve({ expiresAt: now() + 8n });
    const sell = await order(alice, delegate, { side: 1, expiry: String(limits.expiresAt) });
    await send([await placement(sell)], delegate);
    while (now() <= limits.expiresAt + 1n) await Bun.sleep(250);
    // New order expiry itself is valid; grant authority is what has expired.
    await expect(send([await placement(await order(alice, delegate))], delegate)).rejects.toThrow(
      "DelegationInactive",
    );
    await send([await client.cancel(new PublicKey(orderId(sell)), attacker.publicKey)], attacker);
    expect((await client.order(new PublicKey(orderId(sell)))).status).toBe(3);
  }, 30_000);

  test("delegated self-matching shares one grant safely and charges only the new reservation", async () => {
    const { delegate } = await approve();
    const sell = await order(alice, delegate, { side: 1 });
    await send([await placement(sell)], delegate);
    const buy = await order(alice, delegate);
    await send([await placement(buy, [sell])], delegate);
    expect(
      big((await client.delegation(alice.publicKey, delegate.publicKey)).remaining_quote),
    ).toBe(9960n);
    for (const o of [sell, buy])
      expect((await client.order(new PublicKey(orderId(o)))).status).toBe(2);
  }, 30_000);

  test("approval validation runs on chain, and failed grants leave no reusable initialized capability", async () => {
    for (const attack of [
      "zero-key",
      "self-key",
      "expired",
      "unbounded",
      "zero-budget",
      "fee",
      "permission",
    ] as const) {
      const delegate = Keypair.generate();
      const ix = client.approveDelegate(alice.publicKey, delegate.publicKey, {
        market: null,
        expiresAt: now() + 3600n,
        maxOrderQuote: 20n,
        totalQuote: 40n,
        maxFeeBps: 50,
        permissions: 3,
      });
      const args = coder.instruction.decode(ix.data)!.data as any;
      if (attack === "zero-key" || attack === "self-key") {
        const invalid = attack === "zero-key" ? PublicKey.default : alice.publicKey;
        ix.keys[1]!.pubkey = invalid;
        ix.keys[4]!.pubkey = delegationAddress(client.config, alice.publicKey, invalid);
      }
      if (attack === "expired") args.limits.expires_at = bn(0);
      if (attack === "unbounded") args.limits.expires_at = bn(now() + 91n * 24n * 3600n);
      if (attack === "zero-budget") args.limits.total_quote = bn(0);
      if (attack === "fee") args.limits.max_fee_bps = 1001;
      if (attack === "permission") args.limits.permissions = 255;
      ix.data = coder.instruction.encode("approve_delegate", args);
      await expect(send([ix], alice)).rejects.toThrow(
        attack === "zero-key" ? "InvalidAddress" : "InvalidDelegation",
      );
      expect(await connection().getAccountInfo(ix.keys[4]!.pubkey)).toBeNull();
    }
  }, 30_000);

  test("owner nonce invalidation still rejects delegated maker fills and old order identities cannot be replayed after retirement", async () => {
    const owner = Keypair.generate();
    await fund(owner);
    const { delegate } = await approve({}, owner);
    await send([client.initializeWallet(markets[0]!, owner.publicKey, admin.publicKey)]);
    const ata = await getOrCreateAssociatedTokenAccount(connection(), admin, base, owner.publicKey);
    await mintTo(connection(), admin, base, ata.address, admin, 100n);
    await send([client.depositPool(owner.publicKey, base, 100n)], owner);
    const sell = await order(owner, delegate, { side: 1 });
    await send([await placement(sell)], delegate);
    await send([client.invalidateNonce(owner.publicKey, 1n)], owner);
    await expect(send([await placement(await order(bob, undefined, { tif: 1 }), [sell])], bob)).rejects.toThrow(
      "StalePlan",
    );
    await send(
      [
        client.orderMaintenance(
          "retire_orders",
          markets[0]!,
          owner.publicKey,
          [new PublicKey(orderId(sell))],
          [3],
        ),
      ],
      owner,
    );
    expect(await connection().getAccountInfo(new PublicKey(orderId(sell)))).toBeNull();
    await expect(send([await placement(sell)], delegate)).rejects.toThrow("InvalidTerms");
    const changed = await placement(await order(owner, delegate, { side: 1 }));
    const args = coder.instruction.decode(changed.data)!.data as any;
    args.terms.salt = [...Buffer.from(sell.salt.slice(2), "hex")];
    changed.keys[4]!.pubkey = new PublicKey(orderId(sell));
    changed.data = coder.instruction.encode("place", args);
    await expect(send([changed], delegate)).rejects.toThrow("InvalidTerms");
    expect(await available(base, owner.publicKey)).toBe(100n);
  }, 30_000);

  test("multi-leg market: a delegated bid accepting two issuer legs fills both, and a delegated single-leg ask fills with its grant", async () => {
    const m = markets[2]!,
      marketId = m.toBase58();
    const { delegate } = await approve({ maxOrderQuote: 1000n, totalQuote: 1000n });
    const market = await client.market(m);
    expect(market.bases).toBe(2);
    const leg1 = market.legs[0]!,
      leg2 = market.legs[1]!;
    const asks = [1, 2].map((bases) => ({ bases }));
    const makerAsks: OrderWire[] = [];
    for (const { bases } of asks) {
      const ask = await order(bob, undefined, { marketId, side: 1, bases });
      await send([await placement(ask)], bob);
      makerAsks.push(ask);
    }
    const before = await client.wallet(m, alice.publicKey),
      quoteBefore = await available(quote);
    const bid = await order(alice, delegate, { marketId, bases: 3, quantity: "20" });
    const ix = await placement(bid, makerAsks);
    // touched = both legs of the filled asks.
    expect((coder.instruction.decode(ix.data)!.data as { touched: number }).touched).toBe(3);
    await send([ix], delegate);
    for (const ask of makerAsks)
      expect((await client.order(new PublicKey(orderId(ask)))).status).toBe(2);
    const after = await client.wallet(m, alice.publicKey);
    const raw2 = baseRaw(10n, big(leg2.scale), big(leg2.multiplier));
    expect(big(after!.balances[4]!) - big(before!.balances[4]!)).toBe(
      baseRaw(10n, big(leg1.scale), big(leg1.multiplier)),
    );
    expect(big(after!.balances[7]!) - big(before!.balances[7]!)).toBe(raw2);
    expect(raw2).toBeLessThan(10_000n); // live multiplier above 1.0
    expect(await available(quote)).toBe(quoteBefore - 40n);
    expect(
      big((await client.delegation(alice.publicKey, delegate.publicKey)).remaining_quote),
    ).toBe(960n);
    // Delegated ask of the issuer leg only; the filling buyer's plan carries its grant.
    const issuerBefore = await available(issuer);
    const ask = await order(alice, delegate, { marketId, side: 1, bases: 2 });
    await send([await placement(ask)], delegate);
    const reserved = big((await client.order(new PublicKey(orderId(ask)))).reserved);
    expect(reserved).toBe(baseRaw(10n, big(leg2.scale), big(leg2.multiplier), true));
    expect(await available(issuer)).toBe(issuerBefore - reserved);
    const buy = await order(bob, undefined, { marketId, bases: 2 });
    const fill = await placement(buy, [ask]);
    expect(
      (coder.instruction.decode(fill.data)!.data as { delegations: number; touched: number })
        .delegations,
    ).toBe(1);
    await send([fill], bob);
    expect((await client.order(new PublicKey(orderId(ask)))).status).toBe(2);
    // Round-down delivery; the reservation surplus returns to the owner's pool credit.
    expect(await available(issuer)).toBe(issuerBefore - raw2);
    expect(await client.assetCredit(issuer, delegate.publicKey)).toBeNull();
  }, 60_000);

  test("a trade-only key can perform a permissionless release after owner nonce invalidation", async () => {
    const owner = Keypair.generate();
    await fund(owner);
    const { delegate } = await approve({ permissions: 1 }, owner);
    await send([client.initializeWallet(markets[0]!, owner.publicKey, admin.publicKey)]);
    const ata = await getOrCreateAssociatedTokenAccount(connection(), admin, base, owner.publicKey);
    await mintTo(connection(), admin, base, ata.address, admin, 100n);
    await send([client.depositPool(owner.publicKey, base, 100n)], owner);
    const sell = await order(owner, delegate, { side: 1 });
    await send([await placement(sell)], delegate);
    await expect(
      send([await client.cancel(new PublicKey(orderId(sell)), delegate.publicKey)], delegate),
    ).rejects.toThrow("InvalidDelegation");
    await send([client.invalidateNonce(owner.publicKey, 1n)], owner);
    await send([await client.cancel(new PublicKey(orderId(sell)), delegate.publicKey)], delegate);
    expect(await available(base, owner.publicKey)).toBe(100n);
  }, 30_000);
});
