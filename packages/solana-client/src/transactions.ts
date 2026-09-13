import { Buffer } from "buffer";
import {
  Connection,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  createRevokeInstruction,
} from "@solana/spl-token";
import {
  TOKEN_2022_PROGRAM_ID,
  supportedMint,
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
  vaultAddress,
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

export class SolanaClient {
  readonly connection: Connection;
  readonly program: PublicKey;
  readonly config: PublicKey;
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
    return market;
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
        underlying_vault: vaultAddress(market, collateral, this.program),
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
    await this.market(order.market);
    return this.ix(
      "cancel",
      {},
      {
        actor,
        market: order.market,
        order: orderKey,
        wallet: walletAddress(order.market, order.owner, this.program),
        trader: traderAddress(this.config, order.owner, this.program),
      },
    );
  }
  placement(
    orderWire: OrderWire,
    planWire: AtomicPlan,
  ): TransactionInstruction {
    const o = parseOrder(orderWire),
      p = parseAtomicPlan(planWire, o),
      market = key(o.marketId),
      owner = key(o.maker);
    const writable = (pubkey: PublicKey): AccountMeta => ({
      pubkey,
      isWritable: true,
      isSigner: false,
    });
    const tail: AccountMeta[] = [];
    for (let asset = 2; asset < 6; asset++)
      tail.push(
        writable(claimAddress(market, asset, this.program)),
        writable(vaultAddress(market, asset, this.program)),
      );
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
    return this.ix(
      "place",
      {
        terms: orderTerms(o),
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
        config: this.config,
        market,
        order: orderAddress(market, owner, bytes32(o.salt), this.program),
        token_program: TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
        base_vault: vaultAddress(market, 0, this.program),
        quote_vault: vaultAddress(market, 1, this.program),
      },
      tail,
    );
  }
  /** Initialization/funding is a separate, recoverable wallet transaction. Its
   * exact amount is computed locally. Placement consumes only the reviewed order. */
  async funding(order: OrderWire) {
    const marketKey = key(order.marketId),
      owner = key(order.maker),
      market = await this.market(marketKey);
    const asset = fundingAsset(order),
      mint = market.mints[asset]!;
    const required =
      order.side === 0
        ? quote(BigInt(order.quantity), BigInt(order.limitPriceRawX18), true)
        : BigInt(order.quantity);
    const wallet = await this.wallet(marketKey, owner);
    const available = wallet ? big(wallet.balances[asset]!) : 0n;
    const deficit = required > available ? required - available : 0n;
    const metadata = await supportedMint(this.connection, mint);
    const deposit = deficit
      ? await this.depositForCredit(marketKey, owner, mint, asset, deficit)
      : null;
    let external = 0n;
    try {
      external = (
        await getAccount(
          this.connection,
          getAssociatedTokenAddressSync(mint, owner, true, metadata.program),
          "confirmed",
          metadata.program,
        )
      ).amount;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("name" in error) ||
        error.name !== "TokenAccountNotFoundError"
      )
        throw error;
    }
    const instructions: TransactionInstruction[] = [];
    const participants = [...new Set([order.maker, order.recipient])];
    for (const participant of participants)
      if (!(await this.wallet(marketKey, key(participant))))
        instructions.push(
          this.initializeWallet(marketKey, key(participant), owner),
        );
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
    options: { pinWalletFees?: boolean } = {},
  ) {
    await this.assertNetwork();
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const instructions = unwrap(value, this.program);
    let placementLegs = 0;
    for (const ix of instructions) {
      if (!ix.programId.equals(this.program)) continue;
      const decoded = coder.instruction.decode(ix.data);
      if (decoded?.name === "place") {
        const plan = (decoded.data as { plan: { legs: unknown[] } }).plan;
        if (!Array.isArray(plan.legs) || plan.legs.length > 8)
          throw new Error("Invalid placement compute plan");
        placementLegs += plan.legs.length;
      }
    }
    // Whole-funded legs mint up to four claims each. Independent post-CPI
    // guards can exceed the default 200k CU budget for multi-maker settlement.
    // Deterministic local limit only: never accept an API-provided CU price or
    // add a priority fee. The reviewed program instructions remain unchanged.
    // Strict-review admin transactions must declare their budget before signing:
    // injected wallets otherwise may insert priority-fee instructions themselves.
    // Pinning retains our zero-priority-fee policy; it does not waive base fees/rent.
    if (placementLegs > 0 || options.pinWalletFees)
      instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: Math.min(
            1_400_000,
            200_000 * instructions.length + 100_000 * placementLegs,
          ),
        }),
      );
    if (options.pinWalletFees)
      instructions.splice(
        1,
        0,
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }),
      );
    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    if (transaction.serialize().length > 1232)
      throw new Error(
        "Transaction exceeds the Solana packet limit; reduce the number of makers",
      );
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
