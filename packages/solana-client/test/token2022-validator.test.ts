import { beforeAll, describe, expect, test } from "bun:test";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID as T22,
  ExtensionType,
  AccountState,
  createMint,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializeTransferHookInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeInterestBearingMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializePausableConfigInstruction,
  createSetTransferFeeInstruction,
  createHarvestWithheldTokensToMintInstruction,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  getTransferFeeAmount,
  getTransferFeeConfig,
  getMint,
  freezeAccount,
  thawAccount,
  createApproveInstruction,
  createReallocateInstruction,
  createEnableCpiGuardInstruction,
  createDisableCpiGuardInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createDisableRequiredMemoTransfersInstruction,
} from "@solana/spl-token";
import {
  SolanaClient,
  configAddress,
  marketAddress,
  claimAddress,
  vaultAddress,
  walletAddress,
  digest,
  bn,
  big,
  hex,
  orderId,
  planOrder,
  resolutionHash,
  supportedMint,
  unwrap,
  type OrderWire,
  type Candidate,
  coder,
  key,
} from "../src/index.ts";
import { initializeMarketVaults } from "../src/admin.ts";
import { snapshot as programSnapshot } from "../../../services/solana-indexer/src/projection";
import { reconcileVaults } from "../../../services/solana-indexer/src/reconcile.ts";
import { assertMarketInvariants } from "./validator-invariants.ts";

const rpc = process.env.SOLANA_TEST_RPC;
describe.skipIf(!rpc)("compiled Token-2022 collateral custody", () => {
  const connection = new Connection(
    rpc ?? "http://127.0.0.1:8897",
    "confirmed",
  );
  const admin = Keypair.generate(),
    alice = Keypair.generate(),
    bob = Keypair.generate();
  let client: SolanaClient,
    base: PublicKey,
    quote: PublicKey,
    classic: PublicKey,
    plain: PublicKey;
  let serial = 0;
  const send = async (
    ixs: TransactionInstruction[],
    payer = admin,
    others: Keypair[] = [],
  ) => {
    try {
      const latest = await connection.getLatestBlockhash();
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: latest.blockhash,
          instructions: ixs,
        }).compileToV0Message(),
      );
      tx.sign([payer, ...others]);
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
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
      return signature;
    } catch (error) {
      // web3's signature subscription may reject with TransactionError itself,
      // rather than an Error instance, when skipPreflight sends an invalid tx.
      throw error instanceof Error ? error : new Error(JSON.stringify(error));
    }
  };
  const extendedMint = async (
    extensions: ExtensionType[],
    initialize: (mint: PublicKey) => TransactionInstruction[],
    freeze = false,
  ) => {
    const mint = Keypair.generate(),
      space = getMintLen(extensions);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          space,
          programId: T22,
        }),
        ...initialize(mint.publicKey),
        createInitializeMintInstruction(
          mint.publicKey,
          6,
          admin.publicKey,
          freeze ? admin.publicKey : null,
          T22,
        ),
      ],
      admin,
      [mint],
    );
    return mint.publicKey;
  };
  beforeAll(async () => {
    if (
      !rpc ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(rpc).hostname)
    )
      throw new Error("Localhost mock validator required");
    for (const signer of [admin, alice, bob])
      await connection.confirmTransaction(
        await connection.requestAirdrop(signer.publicKey, 20_000_000_000),
        "confirmed",
      );
    base = await extendedMint(
      [ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer],
      (mint) => [
        createInitializeTransferFeeConfigInstruction(
          mint,
          admin.publicKey,
          admin.publicKey,
          250,
          10n,
          T22,
        ),
        createInitializeMetadataPointerInstruction(
          mint,
          admin.publicKey,
          mint,
          T22,
        ),
      ],
      true,
    );
    quote = await extendedMint([ExtensionType.TransferFeeConfig], (mint) => [
      createInitializeTransferFeeConfigInstruction(
        mint,
        admin.publicKey,
        admin.publicKey,
        100,
        5n,
        T22,
      ),
    ]);
    classic = await createMint(connection, admin, admin.publicKey, null, 6);
    plain = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      6,
      undefined,
      undefined,
      T22,
    );
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
          quote_mint: quote,
          system_program: SystemProgram.programId,
        },
      ),
    ]);
    for (const signer of [alice, bob])
      for (const mint of [base, quote, classic, plain]) {
        const program = mint.equals(classic) ? TOKEN_PROGRAM_ID : T22;
        const ata = await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          mint,
          signer.publicKey,
          false,
          "confirmed",
          undefined,
          program,
        );
        await mintTo(
          connection,
          admin,
          mint,
          ata.address,
          admin,
          1_000_000n,
          [],
          undefined,
          program,
        );
      }
  }, 90_000);
  const creation = (mint: PublicKey) => {
    const id = digest(`token-2022:${admin.publicKey}:${serial++}`),
      market = marketAddress(client.config, id),
      uri = "ipfs://token2022-test";
    const now = Math.floor(Date.now() / 1000);
    return {
      market,
      ix: client.ix(
        "create_market",
        {
          id: [...id],
          terms: {
            condition: [...digest("testcondition")],
            yes_index: 1,
            no_index: 2,
            rules_hash: [...digest("testrules")],
            metadata_hash: [...digest(uri)],
            metadata_uri: uri,
            trading_open: bn(now - 1),
            trading_cutoff: bn(now + 7200),
            tick: bn(10n ** 18n),
            step: bn(1),
            min_notional: bn(1),
            max_quantity: bn(1_000_000),
            max_order: bn(10_000_000),
            max_wallet: bn(20_000_000),
            max_market: bn(40_000_000),
          },
        },
        {
          admin: admin.publicKey,
          config: client.config,
          base_mint: mint,
          quote_mint: quote,
          market,
          system_program: SystemProgram.programId,
        },
      ),
    };
  };
  const fixture = async (mint = base) => {
    const { market, ix } = creation(mint);
    await send([ix]);
    for (const tx of await initializeMarketVaults(
      client,
      market.toBase58(),
      admin.publicKey.toBase58(),
    ))
      await send(unwrap(tx));
    for (const owner of [alice, bob])
      await send([
        client.initializeWallet(market, owner.publicKey, admin.publicKey),
      ]);
    await send([
      client.ix(
        "lifecycle",
        { action: 0, commitment: Array(32).fill(0) },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    return market;
  };
  const balance = async (market: PublicKey, owner = alice, asset = 0) =>
    big((await client.wallet(market, owner.publicKey))!.balances[asset]!);
  const tokenAccount = (address: PublicKey, program = T22) =>
    getAccount(connection, address, "confirmed", program);
  const snapshot = async (market: PublicKey, owner = alice, asset = 0) => {
    const mint = (await client.market(market)).mints[asset]!,
      program = asset < 2 && !mint.equals(classic) ? T22 : TOKEN_PROGRAM_ID;
    const addresses = [
      market,
      walletAddress(market, owner.publicKey),
      vaultAddress(market, asset),
      getAssociatedTokenAddressSync(mint, owner.publicKey, false, program),
    ];
    return (await connection.getMultipleAccountsInfo(addresses)).map((info) =>
      info?.data.toString("base64"),
    );
  };
  test("fee-bearing base and quote: net-only credit, issuer fee harvest cannot reduce backing", async () => {
    const market = await fixture();
    expect((await supportedMint(connection, base)).extensions).toEqual([1, 18]);
    const deposit = await client.depositForCredit(
      market,
      alice.publicKey,
      base,
      0,
      100n,
    );
    expect(deposit.gross).toBe(103n);
    expect(deposit.fee).toBe(3n);
    await send([deposit.instruction], alice);
    expect(await balance(market)).toBe(100n);
    const vault = await tokenAccount(vaultAddress(market, 0));
    expect(vault.amount).toBe(100n);
    expect(getTransferFeeAmount(vault)?.withheldAmount).toBe(3n);
    await send([
      createHarvestWithheldTokensToMintInstruction(base, [vault.address], T22),
    ]);
    expect((await tokenAccount(vault.address)).amount).toBe(100n);
    expect(
      getTransferFeeAmount(await tokenAccount(vault.address))?.withheldAmount,
    ).toBe(0n);
    const quoteDeposit = await client.depositForCredit(
      market,
      bob.publicKey,
      quote,
      1,
      100n,
    );
    await send([quoteDeposit.instruction], bob);
    expect(await balance(market, bob, 1)).toBe(100n);
    expect((await tokenAccount(vaultAddress(market, 1))).amount).toBe(100n);
  }, 90_000);
  test("minimum receipt and wrong token-program attacks revert the entire deposit/withdrawal", async () => {
    const market = await fixture();
    for (const minimum of [0n, 98n, 101n]) {
      const before = await snapshot(market);
      const malicious = client.deposit(
        market,
        alice.publicKey,
        base,
        0,
        100n,
        T22,
        97n,
      );
      malicious.data = coder.instruction.encode("deposit_bounded", {
        asset: 0,
        amount: bn(100),
        minimum_credit: bn(minimum),
      });
      await expect(send([malicious], alice)).rejects.toThrow();
      expect(await snapshot(market)).toEqual(before);
    }
    const before = await snapshot(market);
    await expect(
      send([client.deposit(market, alice.publicKey, base, 0, 100n)], alice),
    ).rejects.toThrow();
    expect(await snapshot(market)).toEqual(before);
    await send(
      [client.deposit(market, alice.publicKey, base, 0, 100n, T22, 97n)],
      alice,
    );
    const funded = await snapshot(market);
    for (const minimum of [0n, 40n, 41n]) {
      const malicious = client.withdraw(
        market,
        alice.publicKey,
        base,
        0,
        40n,
        alice.publicKey,
        T22,
        39n,
      );
      malicious[1]!.data = coder.instruction.encode("withdraw_bounded", {
        asset: 0,
        amount: bn(40),
        minimum_received: bn(minimum),
      });
      await expect(send(malicious, alice)).rejects.toThrow();
      expect(await snapshot(market)).toEqual(funded);
    }
    const destination = getAssociatedTokenAddressSync(
        base,
        bob.publicKey,
        false,
        T22,
      ),
      starting = (await tokenAccount(destination)).amount;
    await send(
      await client.withdrawCredit(
        market,
        alice.publicKey,
        base,
        0,
        40n,
        bob.publicKey,
      ),
      alice,
    );
    expect((await tokenAccount(destination)).amount - starting).toBe(39n);
    expect(await balance(market)).toBe(57n);
    expect((await tokenAccount(vaultAddress(market, 0))).amount).toBe(57n);
  }, 90_000);
  test("mixed classic/Token-2022 and plain Token-2022 mints keep exact raw-unit split/merge semantics", async () => {
    for (const mint of [classic, plain]) {
      const market = await fixture(mint);
      const deposit = await client.depositForCredit(
        market,
        alice.publicKey,
        mint,
        0,
        50n,
      );
      expect(deposit.gross).toBe(50n);
      expect(deposit.fee).toBe(0n);
      await send(
        [
          deposit.instruction,
          client.position("split", market, alice.publicKey, 0, 50n),
        ],
        alice,
      );
      expect(await balance(market, alice, 2)).toBe(50n);
      expect(
        (
          await connection.getAccountInfo(claimAddress(market, 2))
        )?.owner.equals(TOKEN_PROGRAM_ID),
      ).toBe(true);
      await send(
        [client.position("merge", market, alice.publicKey, 0, 50n)],
        alice,
      );
      await send(
        await client.withdrawCredit(market, alice.publicKey, mint, 0, 50n),
        alice,
      );
      expect(await balance(market)).toBe(0n);
      expect(big((await client.market(market)).backing[0]!)).toBe(0n);
    }
  }, 90_000);
  test("fee-aware order funding, whole-funded matching and redemption reconcile all six vaults", async () => {
    const market = await fixture();
    const order = (owner: Keypair, side: number): OrderWire => ({
      marketId: market.toBase58(),
      maker: owner.publicKey.toBase58(),
      recipient: owner.publicKey.toBase58(),
      salt: hex(digest(`feeorder:${serial++}`)),
      quantity: "10",
      limitPriceRawX18: String(2n * 10n ** 18n),
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      nonce: "0",
      maxFeeBps: 0,
      branch: 0,
      side,
      fundingKind: 0,
      tif: side === 0 ? 1 : 0,
    });
    const ask = order(alice, 1),
      bid = order(bob, 0);
    const place = async (
      o: OrderWire,
      owner: Keypair,
      candidates: Candidate[] = [],
    ) => {
      const funding = await client.funding(o);
      expect(funding.balanceSufficient).toBe(true);
      expect(BigInt(funding.transferFee)).toBe(1n);
      if (funding.approvalCall) await send(unwrap(funding.approvalCall), owner);
      const m = await client.market(market),
        plan = planOrder({
          order: o,
          candidates,
          now: BigInt(Math.floor(Date.now() / 1000)),
          step: 1n,
          nextSequence: big(m.sequence[0]!),
          makerFeeBps: 0,
          takerFeeBps: 0,
        });
      await send([client.placement(o, plan)], owner);
    };
    await place(ask, alice);
    await place(bid, bob, [
      { order: ask, orderHash: orderId(ask), remaining: 10n, sequence: 0n },
    ]);
    const audit = () =>
      assertMarketInvariants(
        client,
        market,
        [alice.publicKey, bob.publicKey],
        [key(orderId(ask)), key(orderId(bid))],
      );
    await audit();
    expect(await balance(market, bob, 2)).toBe(10n);
    expect(await balance(market, alice, 4)).toBe(20n);
    expect((await client.market(market)).backing.map(big)).toEqual([10n, 20n]);
    await send([
      client.ix(
        "lifecycle",
        { action: 1, commitment: [...digest("freeze")] },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    const uri = "ipfs://resolution",
      evidence = digest("token2022-evidence"),
      commitment = resolutionHash(client.config, market, 1, 0, evidence, uri);
    await send([
      client.ix(
        "lifecycle",
        { action: 3, commitment: [...commitment] },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    await send([
      client.ix(
        "resolve",
        { yes: 1, no: 0, evidence: [...evidence], uri },
        { actor: admin.publicKey, config: client.config, market },
      ),
    ]);
    await send(
      [client.position("redeem", market, bob.publicKey, 0, 10n, 0)],
      bob,
    );
    await send(
      [client.position("redeem", market, alice.publicKey, 1, 20n, 0)],
      alice,
    );
    await audit();
    await send(
      await client.withdrawCredit(market, bob.publicKey, base, 0, 10n),
      bob,
    );
    const signature = await send(
      await client.withdrawCredit(market, alice.publicKey, quote, 1, 20n),
      alice,
    );
    await connection.confirmTransaction(signature, "finalized");
    expect(
      (await reconcileVaults(client, await programSnapshot(client))).checkedVaults,
    ).toBe(6);
    expect(await balance(market, bob, 0)).toBe(0n);
    expect(await balance(market, alice, 1)).toBe(0n);
    await audit();
  }, 120_000);
  test("INVALID exact recovery preserves odd claims for both fee-bearing collateral mints", async () => {
    const market = await fixture();
    for (const collateral of [0, 1]) {
      const mint = [base, quote][collateral]!;
      const deposit = await client.depositForCredit(
        market,
        alice.publicKey,
        mint,
        collateral,
        9n,
      );
      await send(
        [
          deposit.instruction,
          client.position("split", market, alice.publicKey, collateral, 9n),
        ],
        alice,
      );
    }
    const evidence = digest("fee-invalid"),
      uri = "ipfs://fee-invalid";
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
    for (const collateral of [0, 1]) {
      const custodyBefore = (
        await tokenAccount(vaultAddress(market, collateral))
      ).amount;
      const protectedBefore = await snapshot(market, alice, collateral);
      await expect(
        send(
          [client.redeem(market, alice.publicKey, collateral, 1n, 0n)],
          alice,
        ),
      ).rejects.toThrow("6018");
      expect(await snapshot(market, alice, collateral)).toEqual(
        protectedBefore,
      );
      const recovery = await client.redemptionTransaction(
        market,
        alice.publicKey,
        collateral,
        9n,
        2n,
      );
      expect(recovery.recovery.credit).toBe(5n);
      expect(recovery.recovery.retainedYes).toBe(1n);
      await send(unwrap(recovery), alice);
      expect(await balance(market, alice, 2 + 2 * collateral)).toBe(1n);
      expect(await balance(market, alice, 3 + 2 * collateral)).toBe(7n);
      await send(
        unwrap(
          await client.redemptionTransaction(
            market,
            alice.publicKey,
            collateral,
            1n,
            7n,
          ),
        ),
        alice,
      );
      expect(await balance(market, alice, collateral)).toBe(9n);
      expect(big((await client.market(market)).backing[collateral]!)).toBe(0n);
      // Internal recovery makes no issuer transfer: neither burns nor withheld
      // transfer fees change the spendable underlying custody balance.
      expect(
        (await tokenAccount(vaultAddress(market, collateral))).amount,
      ).toBe(custodyBefore);
    }
    await assertMarketInvariants(client, market, [
      alice.publicKey,
      bob.publicKey,
    ]);
  }, 90_000);

  test("issuer freeze failures preserve claims and recover after issuer thaw", async () => {
    const market = await fixture();
    await send(
      [
        (await client.depositForCredit(market, alice.publicKey, base, 0, 100n))
          .instruction,
      ],
      alice,
    );
    const vault = vaultAddress(market, 0);
    await freezeAccount(
      connection,
      admin,
      vault,
      base,
      admin,
      [],
      undefined,
      T22,
    );
    const frozen = await snapshot(market);
    await expect(
      send(
        await client.withdrawCredit(market, alice.publicKey, base, 0, 50n),
        alice,
      ),
    ).rejects.toThrow();
    expect(await snapshot(market)).toEqual(frozen);
    await thawAccount(
      connection,
      admin,
      vault,
      base,
      admin,
      [],
      undefined,
      T22,
    );
    await send(
      await client.withdrawCredit(market, alice.publicKey, base, 0, 50n),
      alice,
    );
    expect(await balance(market)).toBe(50n);
  }, 90_000);
  test("unsupported issuer extensions are rejected by both SDK and on-chain market admission", async () => {
    const cases: [
      ExtensionType,
      (mint: PublicKey) => TransactionInstruction,
      boolean?,
    ][] = [
      [
        ExtensionType.PermanentDelegate,
        (m) =>
          createInitializePermanentDelegateInstruction(m, admin.publicKey, T22),
      ],
      [
        ExtensionType.NonTransferable,
        (m) => createInitializeNonTransferableMintInstruction(m, T22),
      ],
      [
        ExtensionType.TransferHook,
        (m) =>
          createInitializeTransferHookInstruction(
            m,
            admin.publicKey,
            PublicKey.default,
            T22,
          ),
      ],
      [
        ExtensionType.MintCloseAuthority,
        (m) =>
          createInitializeMintCloseAuthorityInstruction(
            m,
            admin.publicKey,
            T22,
          ),
      ],
      [
        ExtensionType.DefaultAccountState,
        (m) =>
          createInitializeDefaultAccountStateInstruction(
            m,
            AccountState.Frozen,
            T22,
          ),
        true,
      ],
      [
        ExtensionType.InterestBearingConfig,
        (m) =>
          createInitializeInterestBearingMintInstruction(
            m,
            admin.publicKey,
            100,
            T22,
          ),
      ],
      [
        ExtensionType.ScaledUiAmountConfig,
        (m) =>
          createInitializeScaledUiAmountConfigInstruction(
            m,
            admin.publicKey,
            2,
            T22,
          ),
      ],
      [
        ExtensionType.PausableConfig,
        (m) =>
          createInitializePausableConfigInstruction(m, admin.publicKey, T22),
      ],
    ];
    for (const [extension, initialize, freeze] of cases) {
      const mint = await extendedMint(
        [extension],
        (m) => [initialize(m)],
        freeze,
      );
      await expect(supportedMint(connection, mint)).rejects.toThrow(
        "Unsupported",
      );
      const { market, ix } = creation(mint);
      await expect(send([ix])).rejects.toThrow("6014");
      expect(await connection.getAccountInfo(market)).toBeNull();
    }
  }, 120_000);
  test.skipIf(process.env.SOLANA_TEST_SHORT_EPOCHS !== "1")(
    "scheduled fee increase invalidates old signed minimums without losing credits",
    async () => {
      const schedule = await connection.getEpochSchedule();
      if (schedule.slotsPerEpoch > 128)
        throw new Error(
          "Fee epoch test requires a fresh validator with --slots-per-epoch 64",
        );
      const market = await fixture();
      await send(
        [
          (
            await client.depositForCredit(
              market,
              alice.publicKey,
              base,
              0,
              100n,
            )
          ).instruction,
        ],
        alice,
      );
      const oldDeposit = await client.depositForCredit(
        market,
        alice.publicKey,
        base,
        0,
        100n,
      );
      const oldWithdrawal = await client.withdrawCredit(
        market,
        alice.publicKey,
        base,
        0,
        50n,
      );
      await send([
        createSetTransferFeeInstruction(
          base,
          admin.publicKey,
          [],
          1000,
          100n,
          T22,
        ),
      ]);
      const config = getTransferFeeConfig(
        await getMint(connection, base, "confirmed", T22),
      )!;
      const deadline = Date.now() + 90_000;
      while (
        BigInt((await connection.getEpochInfo()).epoch) <
        config.newerTransferFee.epoch
      ) {
        if (Date.now() > deadline)
          throw new Error("Timed out waiting for scheduled transfer fee epoch");
        await Bun.sleep(1000);
      }
      const before = await snapshot(market);
      await expect(send([oldDeposit.instruction], alice)).rejects.toThrow(
        "6015",
      );
      expect(await snapshot(market)).toEqual(before);
      await expect(send(oldWithdrawal, alice)).rejects.toThrow("6015");
      expect(await snapshot(market)).toEqual(before);
      const fresh = await client.withdrawalQuote(base, 50n);
      expect(fresh.fee).toBe(5n);
      await send(
        await client.withdrawCredit(market, alice.publicKey, base, 0, 50n),
        alice,
      );
      expect(await balance(market)).toBe(50n);
    },
    150_000,
  );
  test("wallet transfer/revoke use Token-2022; account CPI and memo restrictions cannot be bypassed", async () => {
    // Separate mint prevents user-controlled account extensions leaking into other cases.
    const mint = await extendedMint([ExtensionType.TransferFeeConfig], (m) => [
      createInitializeTransferFeeConfigInstruction(
        m,
        admin.publicKey,
        admin.publicKey,
        100,
        5n,
        T22,
      ),
    ]);
    const source = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      alice.publicKey,
      false,
      "confirmed",
      undefined,
      T22,
    );
    const destination = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      bob.publicKey,
      false,
      "confirmed",
      undefined,
      T22,
    );
    await mintTo(
      connection,
      admin,
      mint,
      source.address,
      admin,
      1000n,
      [],
      undefined,
      T22,
    );
    const transfer = await client.transfer(
      alice.publicKey,
      mint,
      bob.publicKey,
      100n,
    );
    expect(transfer.issuerTransfers?.[0]?.fee).toBe("1");
    await send(unwrap(transfer), alice);
    expect((await tokenAccount(destination.address)).amount).toBe(99n);
    await send(
      [
        createApproveInstruction(
          source.address,
          bob.publicKey,
          alice.publicKey,
          1n,
          [],
          T22,
        ),
      ],
      alice,
    );
    await send(unwrap(await client.revoke(alice.publicKey, mint)), alice);
    expect((await tokenAccount(source.address)).delegate).toBeNull();
    const market = await fixture(mint);
    await send(
      [
        createReallocateInstruction(
          source.address,
          alice.publicKey,
          [ExtensionType.CpiGuard],
          alice.publicKey,
          [],
          T22,
        ),
        createEnableCpiGuardInstruction(
          source.address,
          alice.publicKey,
          [],
          T22,
        ),
      ],
      alice,
    );
    const before = await snapshot(market);
    const deposit = (
      await client.depositForCredit(market, alice.publicKey, mint, 0, 50n)
    ).instruction;
    await expect(send([deposit], alice)).rejects.toThrow();
    expect(await snapshot(market)).toEqual(before);
    await send(
      [
        createDisableCpiGuardInstruction(
          source.address,
          alice.publicKey,
          [],
          T22,
        ),
        deposit,
      ],
      alice,
    );
    await send(
      [
        createReallocateInstruction(
          destination.address,
          bob.publicKey,
          [ExtensionType.MemoTransfer],
          bob.publicKey,
          [],
          T22,
        ),
        createEnableRequiredMemoTransfersInstruction(
          destination.address,
          bob.publicKey,
          [],
          T22,
        ),
      ],
      bob,
    );
    const funded = await snapshot(market);
    await expect(
      send(
        await client.withdrawCredit(
          market,
          alice.publicKey,
          mint,
          0,
          50n,
          bob.publicKey,
        ),
        alice,
      ),
    ).rejects.toThrow();
    expect(await snapshot(market)).toEqual(funded);
    await send(
      [
        createDisableRequiredMemoTransfersInstruction(
          destination.address,
          bob.publicKey,
          [],
          T22,
        ),
      ],
      bob,
    );
    await send(
      await client.withdrawCredit(
        market,
        alice.publicKey,
        mint,
        0,
        50n,
        bob.publicKey,
      ),
      alice,
    );
    expect(await balance(market)).toBe(0n);
  }, 90_000);
});
