/** Shared helpers for the localhost validator suites (never used against a
 * shared cluster). A fresh admin/config per suite keeps suites independent on
 * one disposable validator. */
import { expect } from "bun:test";
import {
  AddressLookupTableProgram,
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  ExtensionType,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  SolanaClient,
  allLegs,
  big,
  bn,
  configAddress,
  digest,
  key,
  liveLegs,
  marketAddress,
  orderId,
  orderSalt,
  planOrder,
  poolAddress,
  poolVaultAddress,
  assetCreditAddress,
  claimAddress,
  vaultAddress,
  walletAddress,
  traderAddress,
  unwrap,
  type Candidate,
  type OrderWire,
} from "../src/index.ts";
import { initializeMarketVaults, lifecycleTransaction } from "../src/admin.ts";
import {
  issueInstructions,
  mockIssuerInstructions,
  type IssuerProfile,
} from "../../../scripts/solana/mock-issuers.ts";

export const ERROR = {
  InvalidTerms: 6001,
  Unauthorized: 6002,
  InvalidState: 6003,
  InvalidAsset: 6004,
  InsufficientFunds: 6006,
  Insolvent: 6007,
  InvalidAccount: 6008,
  StalePlan: 6009,
  FeeCap: 6011,
  UnsupportedTokenExtension: 6014,
  TransferSlippage: 6015,
  FractionalRedemption: 6018,
  LegHalted: 6022,
  IssuerPaused: 6023,
  TransferHookEnabled: 6024,
} as const;
export type ProtocolErrorName = keyof typeof ERROR;

export const now = () => Math.floor(Date.now() / 1000);

export class ValidatorHarness {
  readonly connection: Connection;
  readonly admin = Keypair.generate();
  client!: SolanaClient;
  /** Unfrozen test lookup tables used by `send` (multi-leg fills exceed the
   * legacy account budget without one, as in production). */
  tables: AddressLookupTableAccount[] = [];
  private serial = 0;
  constructor(readonly rpc: string) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(rpc).hostname))
      throw new Error("Validator suites run only against a disposable localhost validator");
    this.connection = new Connection(rpc, "confirmed");
  }
  unique(label = "x") {
    return `${label}:${this.admin.publicKey.toBase58()}:${this.serial++}`;
  }

  /** Sends without preflight so failures surface program logs; error text
   * contains the custom code JSON and the Anchor error name. */
  async send(instructions: TransactionInstruction[], payer = this.admin, others: Keypair[] = []) {
    // Single attempt: attack tests expect malformed transactions to be dropped
    // and must observe that promptly.
    return this.sendOnce(instructions, payer, others);
  }
  /** Harness setup that must land. A freshly started validator can drop early
   * transactions; once a blockhash has expired its transaction can never land,
   * so resending with a new blockhash cannot double-execute. */
  async sendSetup(instructions: TransactionInstruction[], payer = this.admin, others: Keypair[] = []) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendOnce(instructions, payer, others);
      } catch (error) {
        if (!(error instanceof TransactionExpiredBlockheightExceededError) || attempt === 3) throw error;
      }
    }
  }
  private async sendOnce(instructions: TransactionInstruction[], payer: Keypair, others: Keypair[]) {
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions],
      }).compileToV0Message(this.tables),
    );
    transaction.sign([payer, ...others.filter((o) => !o.publicKey.equals(payer.publicKey))]);
    if (process.env.HARNESS_DEBUG) {
      const sim = await this.connection.simulateTransaction(transaction, { sigVerify: false });
      console.log("simulate", JSON.stringify(sim.value.err), sim.value.logs?.slice(-5));
    }
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: !process.env.HARNESS_DEBUG,
      maxRetries: 3,
    });
    const result = await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (result.value.err) {
      const detail = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      throw new Error(`${JSON.stringify(result.value.err)}\n${detail?.meta?.logMessages?.join("\n") ?? ""}`);
    }
    return signature;
  }
  /** Adds addresses to the harness lookup table (created on first use) and
   * waits until they are usable. */
  async lookup(addresses: PublicKey[]) {
    let table = this.tables[0]?.key;
    if (!table) {
      const [create, address] = AddressLookupTableProgram.createLookupTable({
        authority: this.admin.publicKey,
        payer: this.admin.publicKey,
        recentSlot: await this.connection.getSlot("finalized"),
      });
      await this.sendSetup([create]);
      table = address;
    }
    const known = new Set((this.tables[0]?.state.addresses ?? []).map(String));
    const fresh = [...new Map(addresses.filter((a) => !known.has(String(a))).map((a) => [String(a), a])).values()];
    for (let i = 0; i < fresh.length; i += 20)
      await this.sendSetup([
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: table,
          authority: this.admin.publicKey,
          payer: this.admin.publicKey,
          addresses: fresh.slice(i, i + 20),
        }),
      ]);
    // The RPC send service resolves lookup tables against the rooted bank and
    // silently drops transactions using entries that are not yet finalized.
    const slot = await this.connection.getSlot("confirmed");
    while ((await this.connection.getSlot("finalized")) <= slot) await Bun.sleep(200);
    const { value } = await this.connection.getAddressLookupTable(table, { commitment: "finalized" });
    this.tables = value ? [value] : [];
  }
  /** Every static account a market's placements touch. */
  async lookupMarket(market: PublicKey, owners: PublicKey[] = []) {
    const m = await this.client.market(market);
    const addresses: PublicKey[] = [this.client.config, this.client.program, market, TOKEN_PROGRAM_ID, SystemProgram.programId];
    for (let c = 0; c <= m.bases; c++) {
      const mint = m.mints[3 * c]!,
        pool = poolAddress(this.client.config, mint, this.client.program);
      addresses.push(mint, pool, poolVaultAddress(pool, this.client.program));
      for (const asset of [3 * c + 1, 3 * c + 2])
        addresses.push(claimAddress(market, asset, this.client.program), vaultAddress(market, asset, this.client.program));
      for (const owner of owners) addresses.push(assetCreditAddress(pool, owner, this.client.program));
    }
    for (const owner of owners)
      addresses.push(walletAddress(market, owner, this.client.program), traderAddress(this.client.config, owner, this.client.program));
    await this.lookup(addresses);
  }
  /** Asserts a named protocol error and that the given accounts are unchanged. */
  async rejects(
    attempt: Promise<unknown>,
    name?: ProtocolErrorName,
    unchanged: PublicKey[] = [],
    before?: (string | null)[],
  ) {
    const error = await attempt.then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    if (name)
      expect(
        error!.message.includes(`"Custom":${ERROR[name]}`) ||
          error!.message.includes(`Error Number: ${ERROR[name]}.`) ||
          error!.message.includes(`custom program error: 0x${ERROR[name].toString(16)}`),
      ).toBe(true);
    if (before) expect(await this.snapshot(unchanged)).toEqual(before);
    return error!;
  }
  async snapshot(accounts: PublicKey[]) {
    return (await this.connection.getMultipleAccountsInfo(accounts, "confirmed")).map(
      (a) => a?.data.toString("base64") ?? null,
    );
  }
  async airdrop(...owners: PublicKey[]) {
    for (const owner of owners)
      for (let attempt = 1; ; attempt++) {
        try {
          const latest = await this.connection.getLatestBlockhash("confirmed");
          const signature = await this.connection.requestAirdrop(owner, 50_000_000_000);
          await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
          break;
        } catch (error) {
          // Dropped faucet transfers expire; a new request is a fresh transfer.
          if (!(error instanceof TransactionExpiredBlockheightExceededError) || attempt === 3) throw error;
        }
      }
  }

  /** Classic SPL mint, or a Token-2022 mint with an optional transfer fee. */
  async plainMint(decimals: number, program = TOKEN_PROGRAM_ID, fee?: { bps: number; maximum: bigint }) {
    const mint = Keypair.generate();
    const extensions = fee ? [ExtensionType.TransferFeeConfig] : [];
    const space = program.equals(TOKEN_2022_PROGRAM_ID) ? getMintLen(extensions) : MINT_SIZE;
    await this.sendSetup(
      [
        SystemProgram.createAccount({
          fromPubkey: this.admin.publicKey,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: await this.connection.getMinimumBalanceForRentExemption(space),
          programId: program,
        }),
        ...(fee
          ? [
              createInitializeTransferFeeConfigInstruction(
                mint.publicKey,
                this.admin.publicKey,
                this.admin.publicKey,
                fee.bps,
                fee.maximum,
                program,
              ),
            ]
          : []),
        createInitializeMint2Instruction(mint.publicKey, decimals, this.admin.publicKey, this.admin.publicKey, program),
      ],
      this.admin,
      [mint],
    );
    return mint.publicKey;
  }
  /** Mock issuer mint replicating a mainnet issuer configuration. The harness
   * admin is the mock issuer authority (pause, multiplier, freeze). */
  async issuerMint(
    profile: IssuerProfile,
    ticker = "NVDA",
    options: { multiplier?: number; decimals?: number; transferFee?: { bps: number; maximum: bigint } } = {},
  ) {
    const issuer = await mockIssuerInstructions({
      connection: this.connection,
      payer: this.admin.publicKey,
      authority: this.admin.publicKey,
      profile,
      ticker,
      ...options,
    });
    await this.sendSetup(issuer.instructions, this.admin, [issuer.mint]);
    return { ...issuer, mint: issuer.mint.publicKey };
  }
  async programOf(mint: PublicKey) {
    return (await this.connection.getAccountInfo(mint, "confirmed"))!.owner;
  }
  /** Mint to an owner's ATA (created idempotently). */
  async fund(mint: PublicKey, owner: PublicKey, amount: bigint) {
    const program = await this.programOf(mint);
    const info = await this.connection.getParsedAccountInfo(mint, "confirmed");
    const decimals = (info.value!.data as { parsed: { info: { decimals: number } } }).parsed.info.decimals;
    await this.sendSetup(issueInstructions(mint, this.admin.publicKey, this.admin.publicKey, owner, amount, decimals, program));
    return getAssociatedTokenAddressSync(mint, owner, true, program);
  }
  async tokenBalance(mint: PublicKey, owner: PublicKey) {
    const program = await this.programOf(mint);
    return (await getAccount(this.connection, getAssociatedTokenAddressSync(mint, owner, true, program), "confirmed", program))
      .amount;
  }

  /** Config with the admin in every role, plus the quote pool. */
  async initialize(quote: PublicKey, fees = { maker: 0, taker: 0 }) {
    this.client = new SolanaClient({
      rpcUrl: this.rpc,
      config: configAddress(this.admin.publicKey).toBase58(),
      genesisHash: await this.connection.getGenesisHash(),
    });
    const roles = {
      market_admin: this.admin.publicKey,
      guardian: this.admin.publicKey,
      resolution_admin: this.admin.publicKey,
    };
    await this.sendSetup([
      this.client.ix(
        "initialize",
        { roles },
        {
          admin: this.admin.publicKey,
          config: this.client.config,
          quote_mint: quote,
          system_program: SystemProgram.programId,
        },
      ),
      ...(fees.maker || fees.taker
        ? [
            this.client.ix(
              "configure",
              { roles, maker_bps: fees.maker, taker_bps: fees.taker },
              { admin: this.admin.publicKey, config: this.client.config },
            ),
          ]
        : []),
      this.client.initializePool(quote, this.admin.publicKey, await this.programOf(quote), 0),
    ]);
    return this.client;
  }
  async configure(maker: number, taker: number) {
    const roles = (await this.client.configAccount()).roles;
    await this.sendSetup([
      this.client.ix(
        "configure",
        { roles, maker_bps: maker, taker_bps: taker },
        { admin: this.admin.publicKey, config: this.client.config },
      ),
    ]);
  }

  /** create_market (quote only) → list issuer legs (pools + add_base) →
   * initialize_claims → open, exactly as the admin SDK flow does. */
  async market(
    legs: PublicKey[],
    terms: Record<string, unknown> = {},
    options: { open?: boolean; shareDecimals?: number } = {},
  ) {
    const id = digest(this.unique("market")),
      market = marketAddress(this.client.config, id, this.client.program),
      uri = "ipfs://validator-market";
    const quote = (await this.client.configAccount()).quote_mint;
    const quotePool = poolAddress(this.client.config, quote, this.client.program);
    const createTerms = {
      condition: [...digest("external condition")],
      yes_index: 1,
      no_index: 2,
      rules_hash: [...digest("rules")],
      metadata_hash: [...digest(uri)],
      metadata_uri: uri,
      trading_open: bn(now() - 30),
      trading_cutoff: bn(now() + 3600),
      share_decimals: options.shareDecimals ?? 6,
      tick: bn(10n ** 17n),
      step: bn(10),
      min_notional: bn(1),
      max_quantity: bn(1_000_000_000_000n),
      max_order: bn(1_000_000_000_000n),
      max_wallet: bn(10_000_000_000_000n),
      max_market: bn(100_000_000_000_000n),
      ...terms,
    };
    await this.sendSetup([
      this.client.ix(
        "create_market",
        { id: [...id], terms: createTerms },
        {
          admin: this.admin.publicKey,
          config: this.client.config,
          quote_mint: quote,
          quote_pool: quotePool,
          quote_vault: poolVaultAddress(quotePool, this.client.program),
          market,
          system_program: SystemProgram.programId,
        },
      ),
    ]);
    for (const tx of await initializeMarketVaults(
      this.client,
      market.toBase58(),
      this.admin.publicKey.toBase58(),
      legs.map(String),
    ))
      await this.sendSetup(unwrap(tx, this.client.program));
    this.cachedBases.set(market.toBase58(), legs.length);
    if (options.open !== false) await this.open(market);
    // Positions resolve pools from the remembered market's mints.
    await this.client.market(market);
    return market;
  }
  async open(market: PublicKey) {
    await this.sendSetup(
      unwrap(lifecycleTransaction(this.client.deployment, this.admin.publicKey.toBase58(), market.toBase58(), 0)),
    );
  }
  lifecycle(market: PublicKey, action: number, commitment: Uint8Array | number[] = digest("reason")) {
    return this.client.ix(
      "lifecycle",
      { action, commitment: [...commitment] },
      { actor: this.admin.publicKey, config: this.client.config, market },
    );
  }

  order(
    market: PublicKey,
    owner: Keypair,
    fields: Partial<OrderWire> & Pick<OrderWire, "side">,
  ): OrderWire {
    const nonce = BigInt(fields.nonce ?? "0");
    return {
      maker: owner.publicKey.toBase58(),
      recipient: owner.publicKey.toBase58(),
      marketId: market.toBase58(),
      salt: orderSalt(nonce, digest(this.unique("order"))),
      quantity: "1000",
      limitPriceRawX18: String(10n ** 18n),
      expiry: String(now() + 1800),
      nonce: nonce.toString(),
      maxFeeBps: 1_000,
      branch: 0,
      fundingKind: 0,
      tif: 0,
      bases: fields.side === 1 ? 1 : allLegs((this.cachedBases.get(market.toBase58()) ?? 1)),
      ...fields,
    };
  }
  private readonly cachedBases = new Map<string, number>();
  async legs(market: PublicKey) {
    const m = await this.client.market(market);
    this.cachedBases.set(market.toBase58(), m.bases);
    return { market: m, legs: await liveLegs(this.connection, m, this.client.config, this.client.program) };
  }
  /** Candidates straight from chain (remaining, sequence, reserved). */
  async candidates(makers: OrderWire[]): Promise<Candidate[]> {
    return Promise.all(
      makers.map(async (maker) => {
        const account = await this.client.order(key(orderId(maker, this.client.program)));
        return {
          order: maker,
          orderHash: orderId(maker, this.client.program),
          remaining: big(account.remaining),
          sequence: big(account.sequence),
          reserved: big(account.reserved),
        };
      }),
    );
  }
  /** Plans with live leg state (as the API/UI do) and places. */
  async plan(o: OrderWire, makers: OrderWire[] = [], options: { live?: boolean } = {}) {
    const { market, legs } = await this.legs(key(o.marketId));
    const config = await this.client.configAccount();
    return {
      market,
      plan: planOrder({
        order: o,
        candidates: await this.candidates(makers),
        now: BigInt(now()),
        step: big(market.terms.step),
        nextSequence: big(market.sequence[o.branch]!),
        makerFeeBps: config.maker_bps,
        takerFeeBps: config.taker_bps,
        program: this.client.program,
        ...(options.live === false ? {} : { legs }),
      }),
    };
  }
  async place(o: OrderWire, owner: Keypair, makers: OrderWire[] = [], options: { live?: boolean } = {}) {
    const { market, plan } = await this.plan(o, makers, options);
    await this.send([this.client.placement(o, plan, market)], owner);
    return plan;
  }
  async credit(mint: PublicKey, owner: PublicKey) {
    return big((await this.client.assetCredit(mint, owner))?.available ?? 0);
  }
  async balances(market: PublicKey, owner: PublicKey) {
    return ((await this.client.wallet(market, owner))?.balances ?? []).map(big);
  }
}
