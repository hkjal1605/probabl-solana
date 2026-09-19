import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  type AccountMeta,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  createRevokeInstruction,
} from "@solana/spl-token";
import {
  TOKEN_2022_PROGRAM_ID,
  supportedMint,
  decodeSupportedMint,
  currentTransferFee,
  transferGross,
  transferNet,
  tokenProgram as canonicalTokenProgram,
} from "./tokens.ts";
import {
  PROGRAM_ID,
  U64_MAX,
  key,
  instruction,
  walletAddress,
  traderAddress,
  delegationAddress,
  type TradingDelegateAccount,
  vaultAddress,
  poolAddress, poolVaultAddress, assetCreditAddress,
  type AssetCreditAccount,
  claimAddress,
  orderAddress,
  bytes32,
  orderTerms,
  orderId,
  parseOrder,
  fundingAsset,
  quote,
  big,
  bn,
  coder,
  type ConfigAccount,
  type MarketAccount,
  type OrderAccount,
  type WalletAccount,
  type OrderWire,
} from "./protocol.ts";
import { parseAtomicPlan, type AtomicPlan } from "./planner.ts";
import { exactRedemption, planRedemption } from "./claims.ts";
import { budgetedInstructions, compileTransactionMessage, SIZING_BLOCKHASH } from "./resources.ts";
import { validateDelegateLimits, type DelegateLimits } from "./delegation.ts";

function custodyBounds(
  asset: number,
  amount: bigint,
  minimum: bigint,
  program: PublicKey,
) {
  canonicalTokenProgram(program);
  if (
    !Number.isInteger(asset) ||
    asset < 0 ||
    asset > 5 ||
    typeof amount !== "bigint" ||
    typeof minimum !== "bigint" ||
    amount <= 0n ||
    amount > U64_MAX ||
    minimum <= 0n ||
    minimum > amount
  )
    throw new Error("Invalid custody asset, u64 amount or minimum receipt");
}

export interface Deployment {
  rpcUrl: string;
  config: string;
  genesisHash: string;
  programId?: string;
  /** Deployment-owned frozen ALTs only; mutable tables are rejected. */
  addressLookupTables?: readonly string[];
}
export interface WireInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}
export interface Envelope {
  to: string;
  data: string;
  value: "0";
  /** Locally computed review information, not trusted when received from an API. */
  issuerTransfers?: {
    mint: string;
    gross: string;
    minimumReceived: string;
    fee: string;
  }[];
}
export const wireInstruction = (
  ix: TransactionInstruction,
): WireInstruction => ({
  programId: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => ({ ...k, pubkey: k.pubkey.toBase58() })),
  data: ix.data.toString("base64"),
});
export function envelope(
  instructions: TransactionInstruction[],
  program = PROGRAM_ID,
): Envelope {
  return {
    to: program.toBase58(),
    value: "0",
    data: Buffer.from(
      JSON.stringify(instructions.map(wireInstruction)),
    ).toString("base64"),
  };
}
export function unwrap(
  value: Envelope,
  program = PROGRAM_ID,
): TransactionInstruction[] {
  if (
    value.to !== program.toBase58() ||
    value.value !== "0" ||
    value.data.length > 100_000
  )
    throw new Error("Invalid transaction envelope");
  const wire: unknown = JSON.parse(
    Buffer.from(value.data, "base64").toString(),
  );
  if (!Array.isArray(wire) || wire.length === 0 || wire.length > 32)
    throw new Error("Invalid instruction bundle");
  const allowed = [
    program,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
  ].map((p) => p.toBase58());
  return wire.map((w: WireInstruction) => {
    if (
      !allowed.includes(w.programId) ||
      !Array.isArray(w.accounts) ||
      w.accounts.length > 64 ||
      typeof w.data !== "string"
    )
      throw new Error("Unsupported instruction");
    return new TransactionInstruction({
      programId: key(w.programId),
      keys: w.accounts.map((k) => {
        if (
          typeof k.isSigner !== "boolean" ||
          typeof k.isWritable !== "boolean"
        )
          throw new Error("Invalid account flags");
        return { ...k, pubkey: key(k.pubkey) };
      }),
      data: Buffer.from(w.data, "base64"),
    });
  });
}
export function verifyEnvelope(expected: Envelope, value: unknown): Envelope {
  const actual = (value as { transaction?: Envelope })?.transaction;
  if (
    !actual ||
    actual.to !== expected.to ||
    actual.data !== expected.data ||
    actual.value !== "0"
  )
    throw new Error("API transaction differs from the locally reviewed action");
  return expected;
}

// Frozen tables cannot be extended or deactivated. Share their validated image
// across short-lived client instances; failures are never cached.
const frozenTables = new Map<string, Promise<AddressLookupTableAccount[]>>();

export class SolanaClient {
  private readonly knownMarkets = new Map<string, Pick<MarketAccount, "config" | "mints">>();
  rememberMarket<T extends Pick<MarketAccount, "config" | "mints">>(address: PublicKey, market: T): T {
    if (!market.config.equals(this.config)) throw new Error("Market belongs to another deployment");
    this.knownMarkets.set(address.toBase58(), market);
    return market;
  }
  private mintFor(market: PublicKey, asset: number) {
    const mint = this.knownMarkets.get(market.toBase58())?.mints[asset];
    if (!mint) throw new Error("Indexed market mint context is required for protocol-wide custody");
    return mint;
  }
  initializePool(mint: PublicKey, payer: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
    const pool = poolAddress(this.config, mint, this.program);
    return this.ix("initialize_pool", {}, {payer, config: this.config, mint, pool,
      vault: poolVaultAddress(pool, this.program), token_program: tokenProgram, system_program: SystemProgram.programId});
  }
  initializeCredit(mint: PublicKey, owner: PublicKey, payer = owner) {
    const pool = poolAddress(this.config, mint, this.program);
    return this.ix("initialize_credit", {}, {payer, owner, pool,
      credit: assetCreditAddress(pool, owner, this.program), system_program: SystemProgram.programId});
  }
  async assetCredit(mint: PublicKey, owner: PublicKey): Promise<AssetCreditAccount | null> {
    const pool = poolAddress(this.config, mint, this.program);
    const info = await this.connection.getAccountInfo(assetCreditAddress(pool, owner, this.program));
    if (!info) return null;
    if (!info.owner.equals(this.program)) throw new Error("Invalid asset credit program");
    const credit = coder.accounts.decode("AssetCredit", info.data) as AssetCreditAccount;
    if (!credit.pool.equals(pool) || !credit.owner.equals(owner)) throw new Error("Invalid asset credit identity");
    return credit;
  }
  readonly connection: Connection;
  readonly program: PublicKey;
  readonly config: PublicKey;
  private tablesPromise: Promise<AddressLookupTableAccount[]> | undefined;
  constructor(readonly deployment: Deployment) {
    this.connection = new Connection(deployment.rpcUrl, "confirmed");
    this.program = deployment.programId
      ? key(deployment.programId)
      : PROGRAM_ID;
    this.config = key(deployment.config);
  }
  async assertNetwork() {
    if (!this.deployment.genesisHash)
      throw new Error("Solana genesis hash is not configured");
    if (
      (await this.connection.getGenesisHash()) !== this.deployment.genesisHash
    )
      throw new Error("RPC genesis hash differs from this deployment");
  }
  async lookupTables(): Promise<AddressLookupTableAccount[]> {
    if (!this.tablesPromise) {
      const addresses = this.deployment.addressLookupTables ?? [];
      if (addresses.length > 8 || new Set(addresses).size !== addresses.length)
        throw new Error("Invalid lookup table configuration");
      const scope = JSON.stringify([this.deployment.rpcUrl, this.deployment.genesisHash, addresses]);
      const cached = frozenTables.get(scope);
      if (cached) return cached;
      if (frozenTables.size >= 64) frozenTables.delete(frozenTables.keys().next().value!);
      this.tablesPromise = Promise.all(addresses.map(async (address) => {
        const { value } = await this.connection.getAddressLookupTable(key(address), { commitment: "confirmed" });
        if (!value || !value.isActive() || value.state.authority !== undefined)
          throw new Error("Lookup table must be active and permanently frozen");
        return value;
      })).catch((error) => { frozenTables.delete(scope); this.tablesPromise = undefined; throw error; });
      frozenTables.set(scope, this.tablesPromise);
    }
    return this.tablesPromise;
  }
  async assertTransactionFits(owner: PublicKey, value: Envelope) {
    compileTransactionMessage(owner, budgetedInstructions(unwrap(value, this.program), this.program), SIZING_BLOCKHASH, await this.lookupTables());
  }
  async fetch<T>(kind: string, publicKey: PublicKey): Promise<T> {
    const info = await this.connection.getAccountInfo(publicKey, "confirmed");
    if (!info || !info.owner.equals(this.program))
      throw new Error(`Missing or foreign ${kind} account`);
    return coder.accounts.decode(kind, info.data) as T;
  }
  configAccount() {
    return this.fetch<ConfigAccount>("Config", this.config);
  }
  async market(publicKey: PublicKey) {
    const market = await this.fetch<MarketAccount>("Market", publicKey);
    if (!market.config.equals(this.config))
      throw new Error("Market belongs to another deployment");
    return this.rememberMarket(publicKey, market);
  }
  order(publicKey: PublicKey) {
    return this.fetch<OrderAccount>("Order", publicKey);
  }
  async wallet(
    market: PublicKey,
    owner: PublicKey,
  ): Promise<WalletAccount | null> {
    const info = await this.connection.getAccountInfo(
      walletAddress(market, owner, this.program),
    );
    if (!info) return null;
    if (!info.owner.equals(this.program))
      throw new Error("Invalid wallet owner");
    const wallet = coder.accounts.decode("Wallet", info.data) as WalletAccount;
    if (!wallet.market.equals(market) || !wallet.owner.equals(owner))
      throw new Error("Invalid wallet identity");
    return wallet;
  }
  ix(
    name: string,
    args: Record<string, unknown>,
    accounts: Record<string, PublicKey>,
    tail: AccountMeta[] = [],
  ) {
    return instruction(name, args, accounts, tail, this.program);
  }
  initializeWallet(market: PublicKey, owner: PublicKey, payer = owner) {
    return this.ix(
      "initialize_wallet",
      {},
      {
        market,
        owner,
        payer,
        wallet: walletAddress(market, owner, this.program),
        trader: traderAddress(this.config, owner, this.program),
        system_program: SystemProgram.programId,
      },
    );
  }
  /** Protocol-wide deposit, independent of any market or market wallet. */
  depositPool(owner: PublicKey, mint: PublicKey, amount: bigint, tokenProgram = TOKEN_PROGRAM_ID, minimumCredit = amount) {
    custodyBounds(0, amount, minimumCredit, tokenProgram);
    const pool = poolAddress(this.config, mint, this.program);
    return this.ix("deposit_pool", { amount: bn(amount), minimum_credit: bn(minimumCredit) }, {
      owner, mint, pool, credit: assetCreditAddress(pool, owner, this.program),
      vault: poolVaultAddress(pool, this.program), external: getAssociatedTokenAddressSync(mint, owner, true, tokenProgram),
      token_program: tokenProgram, system_program: SystemProgram.programId,
    });
  }
  /** Withdraw only unreserved protocol-wide credit to an owner-selected ATA. */
  withdrawPool(owner: PublicKey, mint: PublicKey, amount: bigint, recipient = owner, tokenProgram = TOKEN_PROGRAM_ID, minimumReceived = amount) {
    custodyBounds(0, amount, minimumReceived, tokenProgram);
    const pool = poolAddress(this.config, mint, this.program);
    const destination = getAssociatedTokenAddressSync(mint, recipient, true, tokenProgram);
    return [createAssociatedTokenAccountIdempotentInstruction(owner, destination, recipient, mint, tokenProgram),
      this.ix("withdraw_pool", { amount: bn(amount), minimum_received: bn(minimumReceived) }, {
        owner, mint, pool, credit: assetCreditAddress(pool, owner, this.program),
        vault: poolVaultAddress(pool, this.program), external: destination,
        token_program: tokenProgram, system_program: SystemProgram.programId,
      })];
  }
  deposit(
    market: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    asset: number,
    amount: bigint,
    tokenProgram = TOKEN_PROGRAM_ID,
    minimumCredit = amount,
  ) {
    custodyBounds(asset, amount, minimumCredit, tokenProgram);
    if (asset < 2) {
      return this.depositPool(owner, mint, amount, tokenProgram, minimumCredit);
    }
    return this.ix(
      minimumCredit === amount ? "deposit" : "deposit_bounded",
      { asset, amount: bn(amount), minimum_credit: bn(minimumCredit) },
      {
        owner,
        market,
        mint,
        wallet: walletAddress(market, owner, this.program),
        source: getAssociatedTokenAddressSync(mint, owner, true, tokenProgram),
        vault: vaultAddress(market, asset, this.program),
        token_program: tokenProgram,
      },
    );
  }
  withdraw(
    market: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    asset: number,
    amount: bigint,
    recipient = owner,
    tokenProgram = TOKEN_PROGRAM_ID,
    minimumReceived = amount,
  ) {
    custodyBounds(asset, amount, minimumReceived, tokenProgram);
    const destination = getAssociatedTokenAddressSync(
      mint,
      recipient,
      true,
      tokenProgram,
    );
    if (asset < 2) {
      return this.withdrawPool(owner, mint, amount, recipient, tokenProgram, minimumReceived);
    }
    return [
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        destination,
        recipient,
        mint,
        tokenProgram,
      ),
      this.ix(
        minimumReceived === amount ? "withdraw" : "withdraw_bounded",
        { asset, amount: bn(amount), minimum_received: bn(minimumReceived) },
        {
          owner,
          market,
          mint,
          destination,
          wallet: walletAddress(market, owner, this.program),
          vault: vaultAddress(market, asset, this.program),
          token_program: tokenProgram,
        },
      ),
    ];
  }
  async depositForCredit(
    market: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    asset: number,
    credit: bigint,
  ) {
    const metadata = await supportedMint(this.connection, mint),
      fee = await currentTransferFee(this.connection, metadata);
    const gross = transferGross(credit, fee);
    return {
      gross,
      fee: gross - credit,
      instruction: this.deposit(
        market,
        owner,
        mint,
        asset,
        gross,
        metadata.program,
        credit,
      ),
    };
  }
  async withdrawalQuote(mint: PublicKey, amount: bigint) {
    const metadata = await supportedMint(this.connection, mint),
      fee = await currentTransferFee(this.connection, metadata);
    const received = transferNet(amount, fee);
    if (received <= 0n)
      throw new Error("Issuer transfer fee consumes the entire withdrawal");
    return { program: metadata.program, received, fee: amount - received };
  }
  async withdrawCredit(
    market: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    asset: number,
    amount: bigint,
    recipient = owner,
  ) {
    const quote = await this.withdrawalQuote(mint, amount);
    return this.withdraw(
      market,
      owner,
      mint,
      asset,
      amount,
      recipient,
      quote.program,
      quote.received,
    );
  }
  position(
    kind: "split" | "merge" | "redeem",
    market: PublicKey,
    owner: PublicKey,
    collateral: number,
    amount: bigint,
    branch = 0,
  ) {
    if (collateral !== 0 && collateral !== 1)
      throw new Error("Invalid collateral");
    if (![0, 1].includes(branch)) throw new Error("Invalid claim branch");
    const yes = 2 + collateral * 2,
      no = yes + 1;
    const pool = poolAddress(this.config, this.mintFor(market, collateral), this.program);
    return this.ix(
      kind,
      kind === "redeem"
        ? {
            collateral,
            yes_amount: bn(branch === 0 ? amount : 0n),
            no_amount: bn(branch === 1 ? amount : 0n),
          }
        : { collateral, amount: bn(amount) },
      {
        owner,
        market,
        wallet: walletAddress(market, owner, this.program),
        yes_mint: claimAddress(market, yes, this.program),
        no_mint: claimAddress(market, no, this.program),
        yes_vault: vaultAddress(market, yes, this.program),
        no_vault: vaultAddress(market, no, this.program),
        token_program: TOKEN_PROGRAM_ID,
        underlying_vault: poolVaultAddress(pool, this.program),
        system_program: SystemProgram.programId,
        pool, credit: assetCreditAddress(pool, owner, this.program),
      },
    );
  }
  /** Raw combined redemption; the contract rejects fractional INVALID burns. */
  redeem(
    market: PublicKey,
    owner: PublicKey,
    collateral: number,
    yes: bigint,
    no: bigint,
  ) {
    if (
      ![0, 1].includes(collateral) ||
      yes < 0n ||
      no < 0n ||
      yes > U64_MAX ||
      no > U64_MAX ||
      yes + no === 0n
    )
      throw new Error("Invalid redemption quantities");
    const ix = this.position("redeem", market, owner, collateral, yes, 0);
    ix.data = coder.instruction.encode("redeem", {
      collateral,
      yes_amount: bn(yes),
      no_amount: bn(no),
    });
    return ix;
  }

  /** Locally prepared recovery for explicit YES/NO quantities (possibly held
   * partly in external ATAs). The returned envelope is exactly what is reviewed.
   * An unredeemable odd remainder produces no burn instruction for that claim. */
  async redemptionTransaction(
    marketKey: PublicKey,
    owner: PublicKey,
    collateral: number,
    yes: bigint,
    no: bigint,
  ) {
    if (![0, 1].includes(collateral)) throw new Error("Invalid collateral");
    const market = await this.market(marketKey);
    if (![6, 7].includes(market.state))
      throw new Error("Market is not redeemable");
    const recovery = planRedemption(yes, no, market.payouts);
    const wallet = await this.wallet(marketKey, owner);
    const instructions: TransactionInstruction[] = [];
    if (recovery.burnYes + recovery.burnNo > 0n && !wallet)
      instructions.push(this.initializeWallet(marketKey, owner));
    for (const [branch, needed] of [
      recovery.burnYes,
      recovery.burnNo,
    ].entries()) {
      const asset = 2 + 2 * collateral + branch;
      const available = wallet ? big(wallet.balances[asset]!) : 0n;
      if (available < needed) {
        const deposit = await this.depositForCredit(
          marketKey,
          owner,
          market.mints[asset]!,
          asset,
          needed - available,
        );
        instructions.push(deposit.instruction);
      }
    }
    if (recovery.merge > 0n)
      instructions.push(
        this.position("merge", marketKey, owner, collateral, recovery.merge),
      );
    if (recovery.redeemYes + recovery.redeemNo > 0n)
      instructions.push(
        this.redeem(
          marketKey,
          owner,
          collateral,
          recovery.redeemYes,
          recovery.redeemNo,
        ),
      );
    return {
      ...envelope(instructions, this.program),
      recovery,
      payouts: [...market.payouts],
      executable: instructions.length > 0,
    };
  }
  async cancel(orderKey: PublicKey, actor: PublicKey) {
    const order = await this.order(orderKey);
    return this.cancelIndexed(orderKey, actor, order, await this.market(order.market));
  }
  cancelIndexed(orderKey: PublicKey, actor: PublicKey, order: OrderAccount, market: MarketAccount) {
    this.rememberMarket(order.market, market);
    return this.ix(
      "cancel",
      {},
      {
        actor,
        market: order.market,
        order: orderKey,
        wallet: walletAddress(order.market, order.owner, this.program),
        trader: traderAddress(this.config, order.owner, this.program),
        ...(order.delegate.equals(PublicKey.default) ? {} : {delegation: delegationAddress(this.config, order.owner, order.delegate, this.program)}),
      },
      order.terms.funding === 0 ? [{pubkey: assetCreditAddress(poolAddress(this.config, this.mintFor(order.market, order.terms.side === 0 ? 1 : 0), this.program), order.owner, this.program), isSigner: false, isWritable: true}] : [],
    );
  }
  /** Bounded owner-only batch, using indexed addresses rather than per-order RPC. */
  orderMaintenance(kind: "cancel_orders" | "retire_orders", market: PublicKey, owner: PublicKey, orders: PublicKey[], refundAssets: readonly number[] = [], delegate?: PublicKey) {
    if (delegate && (kind !== "cancel_orders" || delegate.equals(owner))) throw new Error("Invalid delegated maintenance");
    if (orders.length < 1 || orders.length > 8 || new Set(orders.map(String)).size !== orders.length)
      throw new Error("Order batch must contain 1–8 unique addresses");
    if (refundAssets.some(asset => asset !== 0 && asset !== 1) || new Set(refundAssets).size !== refundAssets.length)
      throw new Error("Invalid refund assets");
    const credits = refundAssets.map(asset => assetCreditAddress(poolAddress(this.config, this.mintFor(market, asset), this.program), owner, this.program));
    return this.ix(kind, { order_count: orders.length }, {
      owner, market, actor: delegate ?? owner,
      ...(delegate ? {delegation: delegationAddress(this.config, owner, delegate, this.program)} : {}),
      wallet: walletAddress(market, owner, this.program),
      trader: traderAddress(this.config, owner, this.program),
    }, [...orders, ...credits].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })));
  }
  invalidateNonce(owner: PublicKey, minimum: bigint) {
    if (minimum <= 0n || minimum > U64_MAX) throw new Error("Invalid minimum nonce");
    return this.ix("invalidate_nonce", { minimum: bn(minimum) }, { owner, trader: traderAddress(this.config, owner, this.program) });
  }
  approveDelegate(owner: PublicKey, delegate: PublicKey, limits: DelegateLimits) {
    validateDelegateLimits(limits);
    if (delegate.equals(PublicKey.default) || delegate.equals(owner)) throw new Error("Invalid delegate key");
    return this.ix("approve_delegate", {limits: {
      expires_at: bn(limits.expiresAt), max_order_quote: bn(limits.maxOrderQuote), total_quote: bn(limits.totalQuote),
      max_fee_bps: limits.maxFeeBps, permissions: limits.permissions,
    }}, {owner, delegate, config: this.config, trader: traderAddress(this.config, owner, this.program),
      delegation: delegationAddress(this.config, owner, delegate, this.program),
      ...(limits.market ? {market: limits.market} : {}), system_program: SystemProgram.programId});
  }
  revokeDelegate(owner: PublicKey, delegate: PublicKey) {
    return this.ix("revoke_delegate", {}, {owner, delegation: delegationAddress(this.config, owner, delegate, this.program)});
  }
  revokeAllDelegates(owner: PublicKey) {
    return this.ix("revoke_all_delegates", {}, {owner, trader: traderAddress(this.config, owner, this.program)});
  }
  async delegation(owner: PublicKey, delegate: PublicKey) {
    const value = await this.fetch<TradingDelegateAccount>("TradingDelegate", delegationAddress(this.config, owner, delegate, this.program));
    if (!value.config.equals(this.config) || !value.owner.equals(owner) || !value.delegate.equals(delegate))
      throw new Error("Invalid delegation identity");
    return value;
  }
  compactMarket(market: PublicKey, admin: PublicKey) {
    return this.ix("compact_market", {}, { market, admin, config: this.config });
  }
  placement(
    orderWire: OrderWire,
    planWire: AtomicPlan,
    marketContext?: Pick<MarketAccount, "config" | "mints">,
  ): TransactionInstruction {
    const o = parseOrder(orderWire),
      p = parseAtomicPlan(planWire, o),
      market = key(o.marketId),
      owner = key(o.maker);
    if (marketContext) this.rememberMarket(market, marketContext);
    const pools = [0, 1].map(asset => poolAddress(this.config, this.mintFor(market, asset), this.program));
    const writable = (pubkey: PublicKey): AccountMeta => ({
      pubkey,
      isWritable: true,
      isSigner: false,
    });
    const tail: AccountMeta[] = [];
    for (let asset = 2; asset < 6; asset++) {
      const collateral = Math.floor((asset - 2) / 2);
      const mints = p.makers.length > 0 && (
        (o.fundingKind === 0 && (o.side === 0 ? 1 : 0) === collateral) ||
        p.makers.some((m) => m.fundingKind === 0 && (m.side === 0 ? 1 : 0) === collateral)
      );
      tail.push(
        { pubkey: claimAddress(market, asset, this.program), isWritable: mints, isSigner: false },
        { pubkey: vaultAddress(market, asset, this.program), isWritable: mints, isSigner: false },
      );
    }
    for (const maker of p.makers)
      tail.push(writable(key(orderId(maker, this.program))));
    const owners = new Set([
      o.maker,
      o.recipient,
      ...p.makers.flatMap((m) => [m.maker, m.recipient]),
    ]);
    for (const participant of [...owners].sort())
      tail.push(
        writable(walletAddress(market, key(participant), this.program)),
        {
          pubkey: traderAddress(this.config, key(participant), this.program),
          isWritable: false,
          isSigner: false,
        },
      );
    const credits = new Map<string, PublicKey>();
    const refundedMakers = p.makers.filter((m, i) => {
      if (m.side !== 0) return false;
      const remaining = BigInt(p.expectedRemaining[i]!), quantity = BigInt(p.quantities[i]!), price = BigInt(m.limitPriceRawX18);
      return quote(remaining, price, true) - quote(remaining - quantity, price, true) > quote(quantity, price, false);
    });
    for (const candidate of [o, ...refundedMakers]) {
      if (candidate.fundingKind !== 0) continue;
      const credit = assetCreditAddress(pools[candidate.side === 0 ? 1 : 0]!, key(candidate.maker), this.program);
      credits.set(credit.toBase58(), credit);
    }
    for (const credit of credits.values()) tail.push(writable(credit));
    const grants = new Map<string, PublicKey>();
    for (const maker of p.makers) if (maker.delegate) {
      const grant = delegationAddress(this.config, key(maker.maker), key(maker.delegate), this.program);
      grants.set(grant.toBase58(), grant);
    }
    for (const grant of grants.values()) tail.push({pubkey: grant, isSigner: false, isWritable: false});
    return this.ix(
      "place",
      {
        terms: orderTerms(o),
        participants: owners.size,
        delegations: grants.size,
        plan: {
          deadline: bn(p.deadline),
          next_sequence: bn(p.guard.nextSequence),
          maker_bps: p.guard.makerFeeBps,
          taker_bps: p.guard.takerFeeBps,
          legs: p.quantities.map((quantity, i) => ({
            quantity: bn(quantity),
            expected_remaining: bn(p.expectedRemaining[i]!),
          })),
        },
      },
      {
        owner,
        authority: key(o.delegate ?? o.maker),
        ...(o.delegate ? {delegation: delegationAddress(this.config, owner, key(o.delegate), this.program)} : {}),
        config: this.config,
        market,
        order: orderAddress(market, owner, bytes32(o.salt), this.program),
        token_program: TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
        base_pool: pools[0]!, quote_pool: pools[1]!,
        base_vault: poolVaultAddress(pools[0]!, this.program),
        quote_vault: poolVaultAddress(pools[1]!, this.program),
      },
      tail,
    );
  }
  /** Initialization/funding is a separate, recoverable wallet transaction. Its
   * exact amount is computed locally. Placement consumes only the reviewed order. */
  async funding(order: OrderWire) {
    if (order.delegate) throw new Error("Delegates trade deposited balances only. Funding requires the owner wallet.");
    const marketKey = key(order.marketId),
      owner = key(order.maker),
      participants = [...new Set([order.maker, order.recipient])],
      first = await this.connection.getMultipleAccountsInfoAndContext(
        [marketKey, ...participants.map((p) => walletAddress(marketKey, key(p), this.program))],
        { commitment: "confirmed" },
      );
    if (first.value.length !== participants.length + 1 || !Number.isSafeInteger(first.context.slot))
      throw new Error("Incomplete funding account read");
    const marketInfo = first.value[0];
    if (!marketInfo || !marketInfo.owner.equals(this.program)) throw new Error("Missing or foreign market");
    const market = coder.accounts.decode("Market", marketInfo.data) as MarketAccount;
    if (!market.config.equals(this.config)) throw new Error("Market belongs to another deployment");
    this.rememberMarket(marketKey, market);
    const wallets = participants.map((p, i) => {
      const info = first.value[i + 1];
      if (!info) return null;
      if (!info.owner.equals(this.program)) throw new Error("Invalid wallet owner");
      const w = coder.accounts.decode("Wallet", info.data) as WalletAccount;
      if (!w.market.equals(marketKey) || !w.owner.equals(key(p))) throw new Error("Invalid wallet identity");
      return w;
    });
    const asset = fundingAsset(order),
      mint = market.mints[asset]!;
    const required =
      order.side === 0
        ? quote(BigInt(order.quantity), BigInt(order.limitPriceRawX18), true)
        : BigInt(order.quantity);
    const wallet = wallets[0];
    let available = asset >= 2 && wallet ? big(wallet.balances[asset]!) : 0n;
    let deficit = required > available ? required - available : 0n;
    const instructions: TransactionInstruction[] = [];
    for (const [index, participant] of participants.entries())
      if (!wallets[index]) instructions.push(this.initializeWallet(marketKey, key(participant), owner));
    if (!deficit) return {
      amount: required.toString(), assetKind: "spl-token", approved: instructions.length === 0,
      balanceSufficient: true, depositAmount: "0", transferFee: "0",
      approvalCall: instructions.length ? envelope(instructions, this.program) : null,
    };
    // Both possible ATAs are deterministic; reading them with the mint avoids a
    // mint -> token-program -> ATA waterfall, including for Token-2022.
    const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    const atas = programs.map((p) => getAssociatedTokenAddressSync(mint, owner, true, p));
    const pool = poolAddress(this.config, mint, this.program);
    const creditAddress = assetCreditAddress(pool, owner, this.program);
    const second = await this.connection.getMultipleAccountsInfoAndContext([mint, ...atas, ...(asset < 2 ? [creditAddress] : [])], {
      commitment: "confirmed", minContextSlot: first.context.slot,
    });
    if (second.value.length !== (asset < 2 ? 4 : 3) || second.context.slot < first.context.slot)
      throw new Error("Incomplete or stale funding token read");
    if (asset < 2) {
      const info = second.value[3];
      if (info) {
        if (!info.owner.equals(this.program)) throw new Error("Invalid global credit program");
        const credit = coder.accounts.decode("AssetCredit", info.data) as AssetCreditAccount;
        if (!credit.owner.equals(owner) || !credit.pool.equals(pool)) throw new Error("Invalid global credit identity");
        available = big(credit.available);
      }
      deficit = required > available ? required - available : 0n;
    }
    const metadata = decodeSupportedMint(mint, second.value[0] ?? null);
    const index = programs.findIndex((p) => p.equals(metadata.program));
    const tokenInfo = second.value[index + 1];
    const externalAccount = tokenInfo ? unpackAccount(atas[index]!, tokenInfo, metadata.program) : null;
    if (externalAccount && (!externalAccount.owner.equals(owner) || !externalAccount.mint.equals(mint)))
      throw new Error("Funding token identity mismatch");
    const external = externalAccount?.amount ?? 0n;
    const fee = deficit ? await currentTransferFee(this.connection, metadata) : null;
    const gross = deficit ? transferGross(deficit, fee) : 0n;
    const deposit = deficit ? {
      gross, fee: gross - deficit,
      instruction: this.deposit(marketKey, owner, mint, asset, gross, metadata.program, deficit),
    } : null;
    if (deposit) instructions.push(deposit.instruction);
    return {
      amount: required.toString(),
      assetKind: "spl-token",
      approved: instructions.length === 0,
      balanceSufficient: external >= (deposit?.gross ?? 0n),
      depositAmount: (deposit?.gross ?? 0n).toString(),
      transferFee: (deposit?.fee ?? 0n).toString(),
      approvalCall: instructions.length
        ? envelope(instructions, this.program)
        : null,
    };
  }
  async prepareTransaction(
    owner: PublicKey,
    value: Envelope,
    _options: { pinWalletFees?: boolean } = {},
  ) {
    await this.assertNetwork();
    const instructions = budgetedInstructions(unwrap(value, this.program), this.program);
    const tables = await this.lookupTables();
    // Reject before fetching a blockhash (and before any wallet approval).
    compileTransactionMessage(owner, instructions, SIZING_BLOCKHASH, tables);
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const message = compileTransactionMessage(owner, instructions, latest.blockhash, tables);
    const transaction = new VersionedTransaction(message);
    return { transaction, ...latest };
  }
  async transfer(
    owner: PublicKey,
    mint: PublicKey,
    recipient: PublicKey,
    amount: bigint,
  ) {
    const info = await supportedMint(this.connection, mint),
      fee = await currentTransferFee(this.connection, info),
      source = getAssociatedTokenAddressSync(mint, owner, true, info.program),
      destination = getAssociatedTokenAddressSync(
        mint,
        recipient,
        true,
        info.program,
      );
    const net = transferNet(amount, fee);
    if (net <= 0n)
      throw new Error("Transfer has no spendable recipient amount");
    const result = envelope(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          destination,
          recipient,
          mint,
          info.program,
        ),
        fee
          ? createTransferCheckedWithFeeInstruction(
              source,
              mint,
              destination,
              owner,
              amount,
              info.decimals,
              amount - net,
              [],
              info.program,
            )
          : createTransferCheckedInstruction(
              source,
              mint,
              destination,
              owner,
              amount,
              info.decimals,
              [],
              info.program,
            ),
      ],
      this.program,
    );
    result.issuerTransfers = [
      {
        mint: mint.toBase58(),
        gross: String(amount),
        minimumReceived: String(net),
        fee: String(amount - net),
      },
    ];
    return result;
  }
  async revoke(owner: PublicKey, mint: PublicKey) {
    const info = await supportedMint(this.connection, mint);
    return envelope(
      [
        createRevokeInstruction(
          getAssociatedTokenAddressSync(mint, owner, true, info.program),
          owner,
          [],
          info.program,
        ),
      ],
      this.program,
    );
  }
  async positionTransaction(
    kind: "split" | "merge" | "redeem",
    marketKey: PublicKey,
    owner: PublicKey,
    collateral: number,
    amount: bigint,
    branch = 0,
  ) {
    if (
      amount <= 0n ||
      amount > (1n << 64n) - 1n ||
      ![0, 1].includes(branch) ||
      ![0, 1].includes(collateral)
    )
      throw new Error("Invalid position action");
    const market = await this.market(marketKey),
      wallet = await this.wallet(marketKey, owner),
      instructions: TransactionInstruction[] = [];
    if (kind === "redeem") {
      if (![6, 7].includes(market.state))
        throw new Error("Market is not redeemable");
      exactRedemption(
        branch === 0 ? amount : 0n,
        branch === 1 ? amount : 0n,
        market.payouts,
      );
    }
    const issuerTransfers: NonNullable<Envelope["issuerTransfers"]> = [];
    if (!wallet) instructions.push(this.initializeWallet(marketKey, owner));
    const assets =
      kind === "split"
        ? [collateral]
        : kind === "merge"
          ? [2 + collateral * 2, 3 + collateral * 2]
          : [2 + collateral * 2 + branch];
    for (const asset of assets) {
      const available = wallet ? big(wallet.balances[asset]!) : 0n;
      if (available < amount) {
        const mint = market.mints[asset]!,
          credit = amount - available;
        const deposit = await this.depositForCredit(
          marketKey,
          owner,
          mint,
          asset,
          credit,
        );
        instructions.push(deposit.instruction);
        issuerTransfers.push({
          mint: mint.toBase58(),
          gross: String(deposit.gross),
          minimumReceived: String(credit),
          fee: String(deposit.fee),
        });
      }
    }
    instructions.push(
      this.position(kind, marketKey, owner, collateral, amount, branch),
    );
    return { ...envelope(instructions, this.program), issuerTransfers };
  }
}
