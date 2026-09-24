import { beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  AccountState,
  createApproveInstruction,
  createDisableCpiGuardInstruction,
  createDisableRequiredMemoTransfersInstruction,
  createEnableCpiGuardInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeInterestBearingMintInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createReallocateInstruction,
  createSetTransferFeeInstruction,
  createUpdateTransferHookInstruction,
  ExtensionType,
  freezeAccount,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  getTransferFeeAmount,
  getTransferFeeConfig,
  thawAccount,
  TOKEN_2022_PROGRAM_ID as T22,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  big,
  bn,
  claimAddress,
  claimAsset,
  coder,
  decodeSupportedMint,
  digest,
  fundingAsset,
  key,
  legBit,
  orderId,
  orderWire,
  poolAddress,
  poolVaultAddress,
  assetCreditAddress,
  resolutionHash,
  supportedMint,
  underlyingAsset,
  unwrap,
  vaultAddress,
  walletAddress,
  type AssetPoolAccount,
  type MarketAccount,
  type OrderAccount,
  type OrderWire,
  type WalletAccount,
} from "../src/index.ts";
import { initializeMarketVaults, mintAdmission } from "../src/admin.ts";
import { ValidatorHarness } from "./validator-harness.ts";

const rpc = process.env.SOLANA_TEST_RPC;
// SOLANA_TEST_TOKEN_2022=0 keeps a classic SPL quote; otherwise (default) the
// deployment quote is itself a fee-bearing Token-2022 mint.
const feeQuote = process.env.SOLANA_TEST_TOKEN_2022 !== "0";
const QUOTE_FEE = { bps: 100, maximum: 5n };
const BASE_FEE = { bps: 250, maximum: 10n };
const fee = (gross: bigint, f: { bps: number; maximum: bigint } | null) => {
  if (!f) return 0n;
  const raw = (gross * BigInt(f.bps) + 9_999n) / 10_000n;
  return raw > f.maximum ? f.maximum : raw;
};

describe.skipIf(!rpc)("compiled Token-2022 collateral custody (multi-issuer layout)", () => {
  const h = new ValidatorHarness(rpc ?? "http://127.0.0.1:8899");
  const connection = h.connection;
  const alice = Keypair.generate(),
    bob = Keypair.generate(),
    carol = Keypair.generate(),
    attacker = Keypair.generate();
  let quote: PublicKey, quoteProgram: PublicKey;
  const quoteFee = feeQuote ? QUOTE_FEE : null;
  const client = () => h.client;
  /** Lists a market and records its mints for the SDK's position helpers. */
  const listed = async (...args: Parameters<ValidatorHarness["market"]>) => {
    const market = await h.market(...args);
    await h.client.market(market);
    return market;
  };
  const send = (ixs: TransactionInstruction[], payer = h.admin, others: Keypair[] = []) =>
    h.send(ixs, payer, others);

  /** Token-2022 mint with arbitrary fixed extensions, funded for alice and bob. */
  async function extendedMint(
    extensions: ExtensionType[],
    initialize: (mint: PublicKey) => TransactionInstruction[],
    options: { freeze?: boolean; decimals?: number; fund?: boolean } = {},
  ) {
    const mint = Keypair.generate(),
      space = getMintLen(extensions);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: h.admin.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          space,
          programId: T22,
        }),
        ...initialize(mint.publicKey),
        createInitializeMint2Instruction(
          mint.publicKey,
          options.decimals ?? 6,
          h.admin.publicKey,
          options.freeze ? h.admin.publicKey : null,
          T22,
        ),
      ],
      h.admin,
      [mint],
    );
    if (options.fund !== false)
      for (const owner of [alice, bob]) await h.fund(mint.publicKey, owner.publicKey, 1_000_000n);
    return mint.publicKey;
  }
  /** Fresh fee-bearing base (2.5%, max 10 raw) with metadata pointer and a
   * freeze authority; a fresh mint per test isolates its pool liability. */
  const feeBase = () =>
    extendedMint(
      [ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer],
      (mint) => [
        createInitializeTransferFeeConfigInstruction(
          mint,
          h.admin.publicKey,
          h.admin.publicKey,
          BASE_FEE.bps,
          BASE_FEE.maximum,
          T22,
        ),
        createInitializeMetadataPointerInstruction(mint, h.admin.publicKey, mint, T22),
      ],
      { freeze: true },
    );

  beforeAll(async () => {
    await h.airdrop(h.admin.publicKey, alice.publicKey, bob.publicKey, carol.publicKey, attacker.publicKey);
    quoteProgram = feeQuote ? T22 : TOKEN_PROGRAM_ID;
    quote = await h.plainMint(6, quoteProgram, quoteFee ?? undefined);
    await h.initialize(quote);
    for (const owner of [alice, bob, carol]) await h.fund(quote, owner.publicKey, 1_000_000n);
  }, 120_000);

  const pool = (mint: PublicKey) => poolAddress(client().config, mint);
  const poolVault = (mint: PublicKey) => poolVaultAddress(pool(mint));
  const creditOf = (mint: PublicKey, owner: PublicKey) => assetCreditAddress(pool(mint), owner);
  const ata = (mint: PublicKey, owner: PublicKey, program = T22) =>
    getAssociatedTokenAddressSync(mint, owner, true, program);
  const poolState = (mint: PublicKey) => client().fetch<AssetPoolAccount>("AssetPool", pool(mint));
  const tokenAccount = (address: PublicKey, program = T22) =>
    getAccount(connection, address, "confirmed", program);
  /** Custody snapshot: pool, pool vault, owner's credit and ATA (+ wallet). */
  const custody = (mint: PublicKey, owner: PublicKey, program = T22, market?: PublicKey) => [
    pool(mint),
    poolVault(mint),
    creditOf(mint, owner),
    ata(mint, owner, program),
    ...(market ? [market, walletAddress(market, owner)] : []),
  ];
  const resolve = async (market: PublicKey, yes: number, no: number, label: string) => {
    const evidence = digest(label),
      uri = "ipfs://" + label;
    await send([
      h.lifecycle(market, 1, digest("freeze " + label)),
      h.lifecycle(market, 3, resolutionHash(client().config, market, yes, no, evidence, uri)),
      client().ix(
        "resolve",
        { yes, no, evidence: [...evidence], uri },
        { actor: h.admin.publicKey, config: client().config, market, system_program: SystemProgram.programId },
      ),
    ]);
  };

  /** Same-snapshot accounting audit for one market: claim ledgers equal wallet
   * credits and order reservations, claim vaults cover them, backing covers the
   * outstanding claim supply (including external holders), market underlying
   * credits are always flushed to pools, and each pool vault covers its
   * protocol-wide liability, which covers this market's reservations+backing. */
  async function audit(market: PublicKey, owners: PublicKey[], orders: OrderWire[] = []) {
    const m = await client().market(market);
    const wallets = (
      await connection.getMultipleAccountsInfo(owners.map((o) => walletAddress(market, o)), "confirmed")
    ).map((info) => (info ? (coder.accounts.decode("Wallet", info.data) as WalletAccount) : null));
    const accounts = await Promise.all(orders.map((o) => client().order(key(orderId(o)))));
    const escrow = (asset: number) =>
      accounts.reduce(
        (sum, a) => sum + (fundingAsset(orderWire(a as OrderAccount)) === asset ? big(a.reserved) : 0n),
        0n,
      );
    for (let c = 0; c <= m.bases; c++) {
      const underlying = underlyingAsset(c);
      expect(big(m.credits[underlying]!)).toBe(0n);
      expect(big(m.escrow[underlying]!)).toBe(escrow(underlying));
      const supplies: bigint[] = [];
      for (const branch of [0, 1]) {
        const asset = claimAsset(c, branch);
        const credits = wallets.reduce((s, w) => s + (w ? big(w.balances[asset]!) : 0n), 0n);
        expect(big(m.credits[asset]!)).toBe(credits);
        expect(big(m.escrow[asset]!)).toBe(escrow(asset));
        const [mintInfo, vaultInfo] = await connection.getMultipleAccountsInfo(
          [claimAddress(market, asset), vaultAddress(market, asset)],
          "confirmed",
        );
        const claimMint = unpackMint(claimAddress(market, asset), mintInfo!, TOKEN_PROGRAM_ID);
        const vault = unpackAccount(vaultAddress(market, asset), vaultInfo!, TOKEN_PROGRAM_ID);
        expect(claimMint.mintAuthority?.equals(market)).toBe(true);
        expect(claimMint.decimals).toBe(m.decimals[c]!);
        expect(vault.amount).toBeGreaterThanOrEqual(credits + escrow(asset) + big(m.fees[asset]!));
        expect(claimMint.supply).toBeGreaterThanOrEqual(vault.amount);
        supplies.push(claimMint.supply);
      }
      const [yes, no] = supplies as [bigint, bigint];
      let potential = yes > no ? yes : no;
      if ([6, 7].includes(m.state)) {
        const y = BigInt(m.payouts[0]!),
          n = BigInt(m.payouts[1]!);
        potential = (yes * y + no * n + y + n - 1n) / (y + n);
      }
      expect(big(m.backing[c]!)).toBeGreaterThanOrEqual(potential);
      const mint = m.mints[underlying]!,
        state = await poolState(mint);
      const vault = await tokenAccount(poolVault(mint), await h.programOf(mint));
      expect(big(state.liability)).toBeGreaterThanOrEqual(big(m.escrow[underlying]!) + big(m.backing[c]!));
      expect(vault.amount).toBeGreaterThanOrEqual(big(state.liability));
    }
    for (const w of wallets)
      if (w) for (let c = 0; c < 4; c++) expect(big(w.balances[underlyingAsset(c)]!)).toBe(0n);
    return m;
  }
  /** A pool used by exactly these owners: liability equals their credits plus
   * every listed market's reservations and backing of that mint. */
  async function exactPool(mint: PublicKey, owners: PublicKey[], markets: PublicKey[]) {
    let total = 0n;
    for (const owner of owners) total += await h.credit(mint, owner);
    for (const market of markets) {
      const m = await client().market(market);
      for (let c = 0; c <= m.bases; c++)
        if (m.mints[underlyingAsset(c)]!.equals(mint))
          total += big(m.escrow[underlyingAsset(c)]!) + big(m.backing[c]!);
    }
    expect(big((await poolState(mint)).liability)).toBe(total);
    expect((await tokenAccount(poolVault(mint), await h.programOf(mint))).amount).toBeGreaterThanOrEqual(total);
  }

  test("fee-bearing base and quote: net-only pool credit, issuer fee harvest cannot reduce liability", async () => {
    const base = await feeBase();
    const market = await listed([base]);
    expect((await supportedMint(connection, base)).extensions).toEqual([1, 18]);
    const deposit = await client().depositForCredit(market, alice.publicKey, base, underlyingAsset(1), 100n);
    expect(deposit.gross).toBe(103n);
    expect(deposit.fee).toBe(3n);
    await send([deposit.instruction], alice);
    expect(await h.credit(base, alice.publicKey)).toBe(100n);
    expect(big((await poolState(base)).liability)).toBe(100n);
    const vault = await tokenAccount(poolVault(base));
    expect(vault.amount).toBe(100n);
    expect(getTransferFeeAmount(vault)?.withheldAmount).toBe(3n);
    await send([createHarvestWithheldTokensToMintInstruction(base, [vault.address], T22)]);
    expect((await tokenAccount(vault.address)).amount).toBe(100n);
    expect(getTransferFeeAmount(await tokenAccount(vault.address))?.withheldAmount).toBe(0n);
    expect(big((await poolState(base)).liability)).toBe(100n);
    // Split still sees exactly the spendable, net pool credit.
    await send([client().initializeWallet(market, alice.publicKey), client().position("split", market, alice.publicKey, 1, 100n)], alice);
    expect(await h.credit(base, alice.publicKey)).toBe(0n);
    await expect(send([client().position("split", market, alice.publicKey, 1, 1n)], alice)).rejects.toThrow();
    const before = await h.credit(quote, bob.publicKey),
      liability = big((await poolState(quote)).liability),
      vaultBefore = (await tokenAccount(poolVault(quote), quoteProgram)).amount;
    const quoteDeposit = await client().depositForCredit(market, bob.publicKey, quote, 0, 100n);
    expect(quoteDeposit.fee).toBe(fee(quoteDeposit.gross, quoteFee));
    await send([quoteDeposit.instruction], bob);
    expect((await h.credit(quote, bob.publicKey)) - before).toBe(100n);
    expect(big((await poolState(quote)).liability) - liability).toBe(100n);
    expect((await tokenAccount(poolVault(quote), quoteProgram)).amount - vaultBefore).toBe(100n);
    await audit(market, [alice.publicKey, bob.publicKey]);
    await exactPool(base, [alice.publicKey, bob.publicKey], [market]);
  }, 120_000);

  test("minimum receipt and wrong token-program attacks revert the entire deposit/withdrawal", async () => {
    const base = await feeBase();
    await send([client().initializePool(base, h.admin.publicKey, T22, 0)]);
    const accounts = custody(base, alice.publicKey);
    for (const [minimum, error] of [
      [0n, "InvalidTerms"],
      [98n, "TransferSlippage"],
      [101n, "InvalidTerms"],
    ] as const) {
      const before = await h.snapshot(accounts);
      const malicious = client().depositPool(alice.publicKey, base, 100n, T22, 97n);
      malicious.data = coder.instruction.encode("deposit_pool", {
        amount: bn(100),
        minimum_credit: bn(minimum),
      });
      await h.rejects(send([malicious], alice), error, accounts, before);
    }
    // The default exact minimum cannot be met by a fee-bearing transfer.
    let before = await h.snapshot(accounts);
    await h.rejects(send([client().depositPool(alice.publicKey, base, 100n, T22)], alice), "TransferSlippage", accounts, before);
    // Classic token-program substitution for a Token-2022 mint.
    await h.rejects(send([client().depositPool(alice.publicKey, base, 100n, TOKEN_PROGRAM_ID, 97n)], alice), undefined, accounts, before);
    const substituted = client().depositPool(alice.publicKey, base, 100n, T22, 97n);
    for (const meta of substituted.keys) if (meta.pubkey.equals(T22)) meta.pubkey = TOKEN_PROGRAM_ID;
    await h.rejects(send([substituted], alice), undefined, accounts, before);
    await send([client().depositPool(alice.publicKey, base, 100n, T22, 97n)], alice);
    expect(await h.credit(base, alice.publicKey)).toBe(97n);
    const funded = await h.snapshot(accounts);
    for (const [minimum, error] of [
      [0n, "InvalidTerms"],
      [40n, "TransferSlippage"],
      [41n, "InvalidTerms"],
    ] as const) {
      const malicious = client().withdrawPool(alice.publicKey, base, 40n, alice.publicKey, T22, 39n);
      malicious[1]!.data = coder.instruction.encode("withdraw_pool", {
        amount: bn(40),
        minimum_received: bn(minimum),
      });
      await h.rejects(send(malicious, alice), error, accounts, funded);
    }
    before = await h.snapshot(accounts);
    await h.rejects(
      send(client().withdrawPool(alice.publicKey, base, 40n, alice.publicKey, TOKEN_PROGRAM_ID, 39n), alice),
      undefined,
      accounts,
      before,
    );
    // Only the credit owner can withdraw; an attacker-signed copy reverts.
    const stolen = client().withdrawPool(alice.publicKey, base, 40n, attacker.publicKey, T22, 39n).at(-1)!;
    stolen.keys[0] = { ...stolen.keys[0]!, pubkey: attacker.publicKey };
    await h.rejects(send([stolen], attacker), undefined, accounts, before);
    const destination = ata(base, bob.publicKey),
      starting = (await tokenAccount(destination)).amount;
    const market = PublicKey.default; // withdrawCredit routes an underlying asset to the pool.
    await send(await client().withdrawCredit(market, alice.publicKey, base, underlyingAsset(1), 40n, bob.publicKey), alice);
    expect((await tokenAccount(destination)).amount - starting).toBe(39n);
    expect(await h.credit(base, alice.publicKey)).toBe(57n);
    expect((await tokenAccount(poolVault(base))).amount).toBe(57n);
    expect(big((await poolState(base)).liability)).toBe(57n);
  }, 120_000);

  test("mixed classic, plain Token-2022 and issuer-replica legs keep exact raw-unit split/merge", async () => {
    const classic = await h.plainMint(6, TOKEN_PROGRAM_ID);
    const plain = await h.plainMint(6, T22);
    const replica = await h.issuerMint("xstocks", "SPY");
    const legs = [classic, plain, replica.mint];
    for (const mint of legs) await h.fund(mint, alice.publicKey, 1_000_000n);
    const market = await listed(legs);
    await send([client().initializeWallet(market, alice.publicKey)], alice);
    const m = await client().market(market);
    expect(m.decimals.slice(1)).toEqual([6, 6, 8]);
    expect(m.legs.map((l) => big(l.scale))).toEqual([1n, 1n, 100n]);
    for (const [index, mint] of legs.entries()) {
      const c = index + 1;
      const deposit = await client().depositForCredit(market, alice.publicKey, mint, underlyingAsset(c), 50n);
      expect(deposit.gross).toBe(50n);
      expect(deposit.fee).toBe(0n);
      await send([deposit.instruction, client().position("split", market, alice.publicKey, c, 50n)], alice);
      const balances = await h.balances(market, alice.publicKey);
      expect([balances[claimAsset(c, 0)], balances[claimAsset(c, 1)]]).toEqual([50n, 50n]);
      expect((await connection.getAccountInfo(claimAddress(market, claimAsset(c, 0))))?.owner.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect((await getMint(connection, claimAddress(market, claimAsset(c, 0)))).decimals).toBe(m.decimals[c]!);
      await audit(market, [alice.publicKey]);
      await send([client().position("merge", market, alice.publicKey, c, 50n)], alice);
      await send(await client().withdrawCredit(market, alice.publicKey, mint, underlyingAsset(c), 50n), alice);
      expect(await h.credit(mint, alice.publicKey)).toBe(0n);
      expect(big((await client().market(market)).backing[c]!)).toBe(0n);
      expect(await h.tokenBalance(mint, alice.publicKey)).toBe(1_000_000n);
    }
    await audit(market, [alice.publicKey]);
  }, 180_000);

  test("fee-aware order funding, whole-funded matching and redemption reconcile claim vaults and pools", async () => {
    const base = await feeBase();
    const market = await listed([base]);
    const owners = [alice.publicKey, carol.publicKey];
    await h.lookupMarket(market, owners);
    const ask = h.order(market, alice, { side: 1, bases: legBit(1), quantity: "10", limitPriceRawX18: String(2n * 10n ** 18n), maxFeeBps: 0 });
    const bid = h.order(market, carol, { side: 0, quantity: "10", limitPriceRawX18: String(2n * 10n ** 18n), maxFeeBps: 0, tif: 1 });
    const fund = async (o: OrderWire, owner: Keypair, expectedFee: bigint) => {
      const funding = await client().funding(o);
      expect(funding.balanceSufficient).toBe(true);
      expect(BigInt(funding.transferFee)).toBe(expectedFee);
      if (funding.approvalCall) await send(unwrap(funding.approvalCall), owner);
    };
    // 10 share units deliver 10 raw base (scale 1, no multiplier): gross 11.
    await fund(ask, alice, 1n);
    expect(await h.credit(base, alice.publicKey)).toBe(10n);
    await h.place(ask, alice);
    // Notional 20 quote raw: the quote transfer fee (if any) is paid on top.
    await fund(bid, carol, quoteFee ? fee(21n, quoteFee) : 0n);
    expect(await h.credit(quote, carol.publicKey)).toBe(20n);
    await h.place(bid, carol, [ask]);
    expect(await h.credit(quote, carol.publicKey)).toBe(0n);
    await audit(market, owners, [ask, bid]);
    const carolBalances = await h.balances(market, carol.publicKey),
      aliceBalances = await h.balances(market, alice.publicKey);
    expect(carolBalances[claimAsset(1, 0)]).toBe(10n);
    expect(carolBalances[claimAsset(0, 1)]).toBe(20n);
    expect(aliceBalances[claimAsset(0, 0)]).toBe(20n);
    expect(aliceBalances[claimAsset(1, 1)]).toBe(10n);
    expect((await client().market(market)).backing.map(big)).toEqual([20n, 10n, 0n, 0n]);
    await resolve(market, 1, 0, "token2022-evidence");
    await send([client().positionCredit(market, carol.publicKey, 1), client().position("redeem", market, carol.publicKey, 1, 10n, 0)], carol);
    const aliceQuote = await h.credit(quote, alice.publicKey);
    await send([client().positionCredit(market, alice.publicKey, 0), client().position("redeem", market, alice.publicKey, 0, 20n, 0)], alice);
    expect(await h.credit(quote, alice.publicKey)).toBe(aliceQuote + 20n);
    await audit(market, owners, [ask, bid]);
    const carolBase = await h.tokenBalance(base, carol.publicKey).catch(() => 0n);
    await send(await client().withdrawCredit(market, carol.publicKey, base, underlyingAsset(1), 10n), carol);
    expect((await h.tokenBalance(base, carol.publicKey)) - carolBase).toBe(10n - fee(10n, BASE_FEE));
    const aliceExternal = await h.tokenBalance(quote, alice.publicKey);
    await send(await client().withdrawCredit(market, alice.publicKey, quote, 0, 20n), alice);
    expect((await h.tokenBalance(quote, alice.publicKey)) - aliceExternal).toBe(20n - fee(20n, quoteFee));
    expect(await h.credit(base, carol.publicKey)).toBe(0n);
    const final = await audit(market, owners, [ask, bid]);
    expect(final.backing.map(big)).toEqual([0n, 0n, 0n, 0n]);
    // The base pool is used only by this market: its liability is exact.
    await exactPool(base, owners, [market]);
    expect((await tokenAccount(poolVault(base))).amount).toBe(big((await poolState(base)).liability));
  }, 180_000);

  test("INVALID exact recovery preserves odd claims for both fee-bearing collateral mints", async () => {
    const base = await feeBase();
    const market = await listed([base]);
    const mints = [quote, base];
    const starting = [await h.credit(quote, alice.publicKey), 0n];
    for (const c of [0, 1]) {
      const mint = mints[c]!;
      const deposit = await client().depositForCredit(market, alice.publicKey, mint, underlyingAsset(c), 9n);
      await send([deposit.instruction], alice);
      await send([client().initializeWallet(market, alice.publicKey), client().position("split", market, alice.publicKey, c, 9n)].slice(c ? 1 : 0), alice);
    }
    await resolve(market, 1, 1, "fee-invalid");
    for (const c of [0, 1]) {
      const mint = mints[c]!,
        program = await h.programOf(mint);
      const custodyBefore = (await tokenAccount(poolVault(mint), program)).amount;
      const accounts = [market, walletAddress(market, alice.publicKey), creditOf(mint, alice.publicKey), claimAddress(market, claimAsset(c, 0))];
      const protectedBefore = await h.snapshot(accounts);
      await h.rejects(send([client().redeem(market, alice.publicKey, c, 1n, 0n)], alice), "FractionalRedemption", accounts, protectedBefore);
      const recovery = await client().redemptionTransaction(market, alice.publicKey, c, 9n, 2n);
      expect(recovery.recovery.credit).toBe(5n);
      expect(recovery.recovery.retainedYes).toBe(1n);
      await send(unwrap(recovery), alice);
      const balances = await h.balances(market, alice.publicKey);
      expect([balances[claimAsset(c, 0)], balances[claimAsset(c, 1)]]).toEqual([1n, 7n]);
      await send(unwrap(await client().redemptionTransaction(market, alice.publicKey, c, 1n, 7n)), alice);
      expect(await h.credit(mint, alice.publicKey)).toBe(starting[c]! + 9n);
      expect(big((await client().market(market)).backing[c]!)).toBe(0n);
      // Internal recovery makes no issuer transfer: neither burns nor withheld
      // transfer fees change the spendable underlying custody balance.
      expect((await tokenAccount(poolVault(mint), program)).amount).toBe(custodyBefore);
    }
    await audit(market, [alice.publicKey, bob.publicKey]);
    await exactPool(base, [alice.publicKey, bob.publicKey], [market]);
  }, 180_000);

  test("issuer freeze of a pool vault halts custody and new leg exposure, preserves claims, and recovers after thaw", async () => {
    const base = await feeBase(),
      other = await h.plainMint(6, T22);
    await h.fund(other, alice.publicKey, 1_000_000n);
    const market = await listed([base, other]);
    await send([(await client().depositForCredit(market, alice.publicKey, base, 3, 100n)).instruction], alice);
    await send([(await client().depositForCredit(market, alice.publicKey, other, 6, 100n)).instruction], alice);
    await send([client().initializeWallet(market, alice.publicKey), client().position("split", market, alice.publicKey, 1, 20n)], alice);
    await freezeAccount(connection, h.admin, poolVault(base), base, h.admin, [], { commitment: "confirmed" }, T22);
    const accounts = [...custody(base, alice.publicKey, T22, market), claimAddress(market, claimAsset(1, 0))];
    const frozen = await h.snapshot(accounts);
    await h.rejects(send(await client().withdrawCredit(market, alice.publicKey, base, 3, 50n), alice), undefined, accounts, frozen);
    await h.rejects(send([(await client().depositForCredit(market, alice.publicKey, base, 3, 10n)).instruction], alice), undefined, accounts, frozen);
    await h.rejects(send([client().position("split", market, alice.publicKey, 1, 10n)], alice), "LegHalted", accounts, frozen);
    const ask = h.order(market, alice, { side: 1, bases: legBit(1), quantity: "10" });
    const { plan, market: m } = await h.plan(ask, [], { live: false });
    await h.rejects(send([client().placement(ask, plan, m)], alice), "LegHalted", accounts, frozen);
    const { legs } = await h.legs(market);
    expect(legs[1]!.halt).toBe("vault-frozen");
    expect(legs[2]!.tradable).toBe(true);
    // Another issuer leg of the same market keeps trading.
    await h.place(h.order(market, alice, { side: 1, bases: legBit(2), quantity: "10" }), alice);
    // Existing claims stay recoverable: merge moves no issuer tokens.
    await send([client().position("merge", market, alice.publicKey, 1, 5n)], alice);
    expect(await h.credit(base, alice.publicKey)).toBe(85n);
    await thawAccount(connection, h.admin, poolVault(base), base, h.admin, [], { commitment: "confirmed" }, T22);
    expect((await h.legs(market)).legs[1]!.tradable).toBe(true);
    await send(await client().withdrawCredit(market, alice.publicKey, base, 3, 50n), alice);
    expect(await h.credit(base, alice.publicKey)).toBe(35n);
    await send([client().position("split", market, alice.publicKey, 1, 10n)], alice);
    const balances = await h.balances(market, alice.publicKey);
    expect([balances[claimAsset(1, 0)], balances[claimAsset(1, 1)]]).toEqual([25n, 25n]);
  }, 180_000);

  test("issuer admission tier: replicas need their exact control mask; generic tier and wrong masks reject", async () => {
    for (const [profile, ticker, expected] of [
      ["xstocks", "NVDA", 63],
      ["ondo", "NVDA", 62],
      ["prestocks", "SPACEX", 63],
      ["remora", "NVDA", 47],
    ] as const) {
      const issuer = await h.issuerMint(profile, ticker);
      const info = await connection.getAccountInfo(issuer.mint, "confirmed");
      expect(() => decodeSupportedMint(issuer.mint, info, 0)).toThrow("Unsupported");
      expect(() => decodeSupportedMint(issuer.mint, info, expected & (expected - 1))).toThrow("Unsupported");
      const admission = await mintAdmission(client(), issuer.mint);
      expect(admission.admitted).toBe(expected);
      expect(admission.program.equals(T22)).toBe(true);
      const accounts = [pool(issuer.mint), poolVault(issuer.mint)];
      const lowest = expected & -expected;
      for (const mask of [0, expected & ~lowest, expected | 64, ...(expected === 63 ? [] : [63])])
        await h.rejects(
          send([client().initializePool(issuer.mint, h.admin.publicKey, T22, mask)]),
          "UnsupportedTokenExtension",
          accounts,
          [null, null],
        );
      // Only the market administrator may admit issuer controls.
      await h.rejects(send([client().initializePool(issuer.mint, attacker.publicKey, T22, expected)], attacker), "Unauthorized", accounts, [null, null]);
      await send([client().initializePool(issuer.mint, h.admin.publicKey, T22, expected)]);
      expect((await poolState(issuer.mint)).admitted).toBe(expected);
      // A pool admits exactly once; its vault holds real issuer tokens.
      // PreStocks replicas carry the mainnet 1% transfer fee: the pool
      // credits what arrives and withdrawals pay the fee again.
      await h.fund(issuer.mint, alice.publicKey, 1_000_000n);
      const credited = 1_000n - fee(1_000n, issuer.transferFee);
      await send([client().depositPool(alice.publicKey, issuer.mint, 1_000n, T22, credited)], alice);
      expect(await h.credit(issuer.mint, alice.publicKey)).toBe(credited);
      const received = credited - fee(credited, issuer.transferFee);
      await send(client().withdrawPool(alice.publicKey, issuer.mint, credited, alice.publicKey, T22, received), alice);
      expect(await h.tokenBalance(issuer.mint, alice.publicKey)).toBe(1_000_000n - 1_000n + received);
    }
    // A fee-bearing confidential-transfer mint needs ConfidentialTransferFeeConfig,
    // which is part of the confidential transfer control, not a new one.
    const confidentialFee = await h.issuerMint("xstocks", "TSLA", { transferFee: BASE_FEE });
    expect((await mintAdmission(client(), confidentialFee.mint)).admitted).toBe(63);
    // Tessera mints carry no issuer controls: generic-tier fee tokens.
    const tessera = await h.issuerMint("tessera", "OPENAI");
    expect(tessera.transferFee).toEqual({ bps: 20, maximum: (1n << 64n) - 1n });
    expect((await mintAdmission(client(), tessera.mint)).admitted).toBe(0);
    await h.rejects(
      send([client().initializePool(tessera.mint, h.admin.publicKey, T22, 2)]),
      "UnsupportedTokenExtension",
      [pool(tessera.mint)],
      [null],
    );
    await h.fund(tessera.mint, alice.publicKey, 1_000_000n);
    const tesseraMarket = await listed([tessera.mint]);
    expect((await poolState(tessera.mint)).admitted).toBe(0);
    const tesseraDeposit = await client().depositForCredit(tesseraMarket, alice.publicKey, tessera.mint, 3, 5_000n);
    expect(tesseraDeposit.fee).toBe(fee(tesseraDeposit.gross, tessera.transferFee));
    await send([tesseraDeposit.instruction], alice);
    expect(await h.credit(tessera.mint, alice.publicKey)).toBe(5_000n);
    // A generic fee extension beside issuer controls does not change the mask.
    const feeIssuer = await extendedMint(
      [ExtensionType.TransferFeeConfig, ExtensionType.PausableConfig, ExtensionType.ScaledUiAmountConfig],
      (m) => [
        createInitializeTransferFeeConfigInstruction(m, h.admin.publicKey, h.admin.publicKey, BASE_FEE.bps, BASE_FEE.maximum, T22),
        createInitializePausableConfigInstruction(m, h.admin.publicKey, T22),
        createInitializeScaledUiAmountConfigInstruction(m, h.admin.publicKey, 1.0017, T22),
      ],
      { decimals: 9 },
    );
    expect((await mintAdmission(client(), feeIssuer)).admitted).toBe(2 | 8);
    const market = await listed([feeIssuer]);
    expect((await poolState(feeIssuer)).admitted).toBe(2 | 8);
    expect((await h.legs(market)).legs[1]!.tradable).toBe(true);
    const deposit = await client().depositForCredit(market, alice.publicKey, feeIssuer, 3, 1_000n);
    expect(deposit.fee).toBe(fee(deposit.gross, BASE_FEE));
    await send([deposit.instruction], alice);
    expect(await h.credit(feeIssuer, alice.publicKey)).toBe(1_000n);
  }, 240_000);

  test("non-issuer extensions stay rejected; default-frozen vaults cannot be listed until thawed", async () => {
    const cases: [ExtensionType, (mint: PublicKey) => TransactionInstruction][] = [
      [ExtensionType.NonTransferable, (m) => createInitializeNonTransferableMintInstruction(m, T22)],
      [ExtensionType.MintCloseAuthority, (m) => createInitializeMintCloseAuthorityInstruction(m, h.admin.publicKey, T22)],
      [ExtensionType.InterestBearingConfig, (m) => createInitializeInterestBearingMintInstruction(m, h.admin.publicKey, 100, T22)],
    ];
    for (const [extension, initialize] of cases) {
      const mint = await extendedMint([extension], (m) => [initialize(m)], { fund: false });
      const info = await connection.getAccountInfo(mint, "confirmed");
      expect(() => decodeSupportedMint(mint, info, 63)).toThrow("Unsupported");
      await expect(supportedMint(connection, mint)).rejects.toThrow("Unsupported");
      await expect(mintAdmission(client(), mint)).rejects.toThrow("Unsupported");
      for (const mask of [0, 63])
        await h.rejects(
          send([client().initializePool(mint, h.admin.publicKey, T22, mask)]),
          "UnsupportedTokenExtension",
          [pool(mint)],
          [null],
        );
    }
    // Securitize/Superstate-style default-frozen accounts: admissible (bit 4),
    // but the pool vault starts frozen, so add_base halts until the issuer thaws.
    const frozenMint = await extendedMint(
      [ExtensionType.DefaultAccountState],
      (m) => [createInitializeDefaultAccountStateInstruction(m, AccountState.Frozen, T22)],
      { freeze: true, fund: false },
    );
    const info = await connection.getAccountInfo(frozenMint, "confirmed");
    expect(decodeSupportedMint(frozenMint, info, 4).issuer.defaultFrozen).toBe(true);
    expect((await mintAdmission(client(), frozenMint)).admitted).toBe(4);
    const market = await listed([], {}, { open: false });
    const listing = await initializeMarketVaults(client(), market.toBase58(), h.admin.publicKey.toBase58(), [frozenMint.toBase58()]);
    await h.rejects(send(unwrap(listing[0]!)), "LegHalted");
    await send([client().initializePool(frozenMint, h.admin.publicKey, T22, 4)]);
    expect((await tokenAccount(poolVault(frozenMint))).isFrozen).toBe(true);
    const retry = await initializeMarketVaults(client(), market.toBase58(), h.admin.publicKey.toBase58(), [frozenMint.toBase58()]);
    const scheduled = await h.snapshot([market]);
    await h.rejects(send(unwrap(retry[0]!)), "LegHalted", [market], scheduled);
    await thawAccount(connection, h.admin, poolVault(frozenMint), frozenMint, h.admin, [], { commitment: "confirmed" }, T22);
    for (const tx of await initializeMarketVaults(client(), market.toBase58(), h.admin.publicKey.toBase58(), [frozenMint.toBase58()]))
      await send(unwrap(tx));
    await h.open(market);
    expect((await client().market(market)).bases).toBe(1);
  }, 180_000);

  test("a configured transfer hook fails closed on-chain and in the SDK; unsetting it restores custody", async () => {
    const hookProgram = Keypair.generate().publicKey;
    const hooked = await extendedMint(
      [ExtensionType.TransferHook],
      (m) => [createInitializeTransferHookInstruction(m, h.admin.publicKey, hookProgram, T22)],
      { fund: false },
    );
    const info = await connection.getAccountInfo(hooked, "confirmed");
    expect(() => decodeSupportedMint(hooked, info, 16)).toThrow("transfer hook");
    await expect(mintAdmission(client(), hooked)).rejects.toThrow("transfer hook");
    await h.rejects(send([client().initializePool(hooked, h.admin.publicKey, T22, 16)]), "TransferHookEnabled", [pool(hooked)], [null]);

    // An unset hook is admitted (bit 16); configuring one later halts custody.
    const mint = await extendedMint(
      [ExtensionType.TransferHook],
      (m) => [createInitializeTransferHookInstruction(m, h.admin.publicKey, PublicKey.default, T22)],
    );
    expect((await mintAdmission(client(), mint)).admitted).toBe(16);
    await send([client().initializePool(mint, h.admin.publicKey, T22, 16)]);
    await send([client().depositPool(alice.publicKey, mint, 100n, T22)], alice);
    await send([createUpdateTransferHookInstruction(mint, h.admin.publicKey, hookProgram, [], T22)]);
    const accounts = custody(mint, alice.publicKey);
    const before = await h.snapshot(accounts);
    await h.rejects(send([client().depositPool(alice.publicKey, mint, 10n, T22)], alice), "TransferHookEnabled", accounts, before);
    await h.rejects(send(client().withdrawPool(alice.publicKey, mint, 10n, alice.publicKey, T22), alice), "TransferHookEnabled", accounts, before);
    const market = await listed([], {}, { open: false });
    await h.rejects(
      send([
        client().ix("add_base", {}, {
          admin: h.admin.publicKey,
          config: client().config,
          market,
          mint,
          pool: pool(mint),
          vault: poolVault(mint),
          token_program: T22,
        }),
      ]),
      "TransferHookEnabled",
    );
    await send([createUpdateTransferHookInstruction(mint, h.admin.publicKey, PublicKey.default, [], T22)]);
    await send(client().withdrawPool(alice.publicKey, mint, 100n, alice.publicKey, T22), alice);
    expect(await h.credit(mint, alice.publicKey)).toBe(0n);
  }, 180_000);

  test.skipIf(process.env.SOLANA_TEST_SHORT_EPOCHS !== "1")(
    "scheduled fee increase invalidates old signed minimums without losing credits",
    async () => {
      const schedule = await connection.getEpochSchedule();
      if (schedule.slotsPerEpoch > 128)
        throw new Error("Fee epoch test requires a fresh validator with --slots-per-epoch 64");
      const base = await feeBase();
      const market = await listed([base]);
      await send([(await client().depositForCredit(market, alice.publicKey, base, 3, 100n)).instruction], alice);
      const oldDeposit = await client().depositForCredit(market, alice.publicKey, base, 3, 100n);
      const oldWithdrawal = await client().withdrawCredit(market, alice.publicKey, base, 3, 50n);
      await send([createSetTransferFeeInstruction(base, h.admin.publicKey, [], 1000, 100n, T22)]);
      const config = getTransferFeeConfig(await getMint(connection, base, "confirmed", T22))!;
      const deadline = Date.now() + 90_000;
      while (BigInt((await connection.getEpochInfo()).epoch) < config.newerTransferFee.epoch) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for scheduled transfer fee epoch");
        await Bun.sleep(1000);
      }
      const accounts = custody(base, alice.publicKey);
      const before = await h.snapshot(accounts);
      await h.rejects(send([oldDeposit.instruction], alice), "TransferSlippage", accounts, before);
      await h.rejects(send(oldWithdrawal, alice), "TransferSlippage", accounts, before);
      const fresh = await client().withdrawalQuote(base, 50n);
      expect(fresh.fee).toBe(5n);
      await send(await client().withdrawCredit(market, alice.publicKey, base, 3, 50n), alice);
      expect(await h.credit(base, alice.publicKey)).toBe(50n);
      expect(big((await poolState(base)).liability)).toBe(50n);
    },
    150_000,
  );

  test("wallet transfer/revoke use Token-2022; account CPI and memo restrictions cannot be bypassed", async () => {
    // Separate mint prevents user-controlled account extensions leaking into other cases.
    const mint = await extendedMint(
      [ExtensionType.TransferFeeConfig],
      (m) => [createInitializeTransferFeeConfigInstruction(m, h.admin.publicKey, h.admin.publicKey, 100, 5n, T22)],
      { fund: false },
    );
    const source = await h.fund(mint, alice.publicKey, 1000n);
    const destination = await h.fund(mint, bob.publicKey, 0n);
    const transfer = await client().transfer(alice.publicKey, mint, bob.publicKey, 100n);
    expect(transfer.issuerTransfers?.[0]?.fee).toBe("1");
    await send(unwrap(transfer), alice);
    expect((await tokenAccount(destination)).amount).toBe(99n);
    await send([createApproveInstruction(source, bob.publicKey, alice.publicKey, 1n, [], T22)], alice);
    await send(unwrap(await client().revoke(alice.publicKey, mint)), alice);
    expect((await tokenAccount(source)).delegate).toBeNull();
    await send([client().initializePool(mint, h.admin.publicKey, T22, 0)]);
    await send(
      [
        createReallocateInstruction(source, alice.publicKey, [ExtensionType.CpiGuard], alice.publicKey, [], T22),
        createEnableCpiGuardInstruction(source, alice.publicKey, [], T22),
      ],
      alice,
    );
    const accounts = custody(mint, alice.publicKey);
    const before = await h.snapshot(accounts);
    const deposit = (await client().depositForCredit(PublicKey.default, alice.publicKey, mint, 3, 50n)).instruction;
    await h.rejects(send([deposit], alice), undefined, accounts, before);
    await send([createDisableCpiGuardInstruction(source, alice.publicKey, [], T22), deposit], alice);
    expect(await h.credit(mint, alice.publicKey)).toBe(50n);
    await send(
      [
        createReallocateInstruction(destination, bob.publicKey, [ExtensionType.MemoTransfer], bob.publicKey, [], T22),
        createEnableRequiredMemoTransfersInstruction(destination, bob.publicKey, [], T22),
      ],
      bob,
    );
    const funded = await h.snapshot([...accounts, destination]);
    await h.rejects(
      send(await client().withdrawCredit(PublicKey.default, alice.publicKey, mint, 3, 50n, bob.publicKey), alice),
      undefined,
      [...accounts, destination],
      funded,
    );
    await send([createDisableRequiredMemoTransfersInstruction(destination, bob.publicKey, [], T22)], bob);
    await send(await client().withdrawCredit(PublicKey.default, alice.publicKey, mint, 3, 50n, bob.publicKey), alice);
    expect(await h.credit(mint, alice.publicKey)).toBe(0n);
    expect((await tokenAccount(destination)).amount).toBe(99n + 49n);
  }, 120_000);

  test("market claim custody stays classic SPL for Token-2022 quote and legs; unlisted assets reject", async () => {
    const base = await feeBase();
    const market = await listed([base]);
    const m: MarketAccount = await client().market(market);
    for (const asset of [1, 2, 4, 5])
      expect((await connection.getAccountInfo(m.mints[asset]!))!.owner.equals(TOKEN_PROGRAM_ID)).toBe(true);
    for (const asset of [7, 8, 10, 11]) expect(m.mints[asset]!.equals(PublicKey.default)).toBe(true);
    await send([client().initializeWallet(market, alice.publicKey)], alice);
    // Claim deposits of an unlisted collateral and underlying assets on the
    // market-wallet path are rejected without state changes.
    const before = await h.snapshot([market, walletAddress(market, alice.publicKey)]);
    const bogus = client().ix(
      "deposit",
      { asset: 7, amount: bn(1) },
      {
        owner: alice.publicKey,
        market,
        mint: base,
        wallet: walletAddress(market, alice.publicKey),
        source: ata(base, alice.publicKey),
        vault: vaultAddress(market, 7),
        token_program: T22,
      },
    );
    await h.rejects(send([bogus], alice), undefined, [market, walletAddress(market, alice.publicKey)], before);
  }, 120_000);
});
