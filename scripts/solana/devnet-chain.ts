import {
  type ConfigAccount,
  coder,
  decodeSupportedMint,
  configAddress,
  key,
  mintExtensions,
  SolanaClient,
} from "@conditional-stocks/solana-client";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToCheckedInstruction,
  createSyncNativeInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMetadataPointerState,
  getMintLen,
  getTokenMetadata,
  getTransferFeeConfig,
  LENGTH_SIZE,
  MINT_SIZE,
  TYPE_SIZE,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import {
  type Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSETS,
  type AssetPlan,
  type AssetSpec,
  type DeploymentPlan,
  isIssuer,
  NATIVE_MINT,
  PROGRAM_ID,
  rawAmount,
  tokenProgram,
} from "./devnet-policy.ts";
import { ISSUERS, issuerExtensionTypes, issuerMetadata, mockIssuerInstructions } from "./mock-issuers.ts";

export interface ChainContext {
  connection: Connection;
  deployer: Keypair;
  /** Production caller pins Devnet; a local rehearsal supplies a loopback guard. */
  assertNetwork: () => Promise<void>;
  record: (step: string, value: Record<string, unknown>) => Promise<void>;
}
export function assetPlan(spec: AssetSpec, mint: PublicKey, owner: PublicKey): AssetPlan {
  return {
    symbol: spec.symbol,
    mint: mint.toBase58(),
    ata: getAssociatedTokenAddressSync(mint, owner, false, tokenProgram(spec)).toBase58(),
    program: tokenProgram(spec).toBase58(),
    decimals: spec.decimals,
    initialRaw: rawAmount(spec.units, spec.decimals).toString(),
    name:
      spec.kind === "native"
        ? "Wrapped Devnet SOL"
        : isIssuer(spec)
          ? issuerMetadata(spec.profile, spec.ticker).name
          : "Devnet Mock " + spec.symbol,
    metadataSymbol: spec.kind === "native" ? "SOL" : isIssuer(spec) ? spec.symbol : "d" + spec.symbol,
    metadataUri: isIssuer(spec) ? issuerMetadata(spec.profile, spec.ticker).uri : "",
    feeBps: spec.feeBps,
  };
}
export async function assetInstructions(ctx: ChainContext, spec: AssetSpec, mint: Keypair | null) {
  const owner = ctx.deployer.publicKey,
    program = tokenProgram(spec),
    mintKey = mint?.publicKey ?? NATIVE_MINT;
  const asset = assetPlan(spec, mintKey, owner),
    ata = key(asset.ata);
  const createAta = createAssociatedTokenAccountInstruction(owner, ata, owner, mintKey, program);
  if (spec.kind === "native")
    return {
      asset,
      instructions: [
        // Deliberately NOT idempotent: ATA creation guards this one-time wrap against
        // replays/new blockhash retries. Never top up a wallet that has spent tokens.
        createAta,
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: ata,
          lamports: BigInt(asset.initialRaw),
        }),
        createSyncNativeInstruction(ata, program),
      ],
    };
  if (!mint) throw new Error("Missing mock mint signer");
  if (isIssuer(spec)) {
    // Same Token-2022 extension set and order as the mainnet issuer (the
    // deployer is the mock issuer authority), created, issued and funded in
    // one atomic step. The ATA create is not idempotent: a retry cannot refill.
    const issuer = await mockIssuerInstructions({
      connection: ctx.connection,
      payer: owner,
      authority: owner,
      profile: spec.profile,
      ticker: spec.ticker,
      mint,
    });
    const identity = issuerMetadata(spec.profile, spec.ticker);
    if (
      issuer.symbol !== asset.metadataSymbol ||
      issuer.decimals !== spec.decimals ||
      identity.feeBps !== spec.feeBps ||
      identity.uri !== asset.metadataUri
    )
      throw new Error("Issuer fixture differs from the asset policy");
    return {
      asset,
      instructions: [
        ...issuer.instructions,
        createAta,
        createMintToCheckedInstruction(mintKey, ata, owner, BigInt(asset.initialRaw), spec.decimals, [], program),
      ],
    };
  }
  const metadata = {
    mint: mintKey,
    updateAuthority: owner,
    name: asset.name,
    symbol: asset.metadataSymbol,
    uri: "",
    additionalMetadata: [],
  };
  const extensions: ExtensionType[] = [];
  const space = extensions.length ? getMintLen(extensions) : MINT_SIZE;
  // Allocate fixed extensions first; InitializeMetadata reallocates using the
  // already funded rent. Creation, metadata, ATA and initial mint are atomic.
  const rentSize =
    space + (extensions.length ? TYPE_SIZE + LENGTH_SIZE + pack(metadata).length : 0);
  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey: mintKey,
      lamports: await ctx.connection.getMinimumBalanceForRentExemption(rentSize),
      space,
      programId: program,
    }),
  ];
  const feeBps: number = spec.feeBps;
  if (extensions.length) {
    instructions.push(createInitializeMetadataPointerInstruction(mintKey, owner, mintKey, program));
    if (feeBps)
      instructions.push(
        createInitializeTransferFeeConfigInstruction(
          mintKey,
          owner,
          owner,
          feeBps,
          10n ** BigInt(spec.decimals),
          program,
        ),
      );
  }
  instructions.push(createInitializeMint2Instruction(mintKey, spec.decimals, owner, null, program));
  if (extensions.length)
    instructions.push(
      createInitializeInstruction({
        programId: program,
        metadata: mintKey,
        updateAuthority: owner,
        mint: mintKey,
        mintAuthority: owner,
        name: metadata.name,
        symbol: metadata.symbol,
        uri: "",
      }),
    );
  instructions.push(
    createAta,
    createMintToCheckedInstruction(
      mintKey,
      ata,
      owner,
      BigInt(asset.initialRaw),
      spec.decimals,
      [],
      program,
    ),
  );
  return { asset, instructions };
}
export async function sendStep(
  ctx: ChainContext,
  step: string,
  instructions: TransactionInstruction[],
  others: Keypair[] = [],
) {
  await ctx.assertNetwork();
  const latest = await ctx.connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: ctx.deployer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message(),
  );
  tx.sign([ctx.deployer, ...others]);
  const bytes = tx.serialize();
  if (bytes.length > 1232) throw new Error("Deployment transaction exceeds packet limit");
  // Persist signed bytes before submission. No private key is in a transaction.
  // A rerun verifies the on-chain postcondition before attempting this step.
  await ctx.record(step, {
    status: "submitting",
    signedTransaction: Buffer.from(bytes).toString("base64"),
    ...latest,
  });
  // Match the blockhash's bank. Connection defaults to finalized for read-back;
  // a finalized-bank preflight cannot yet see a fresh confirmed blockhash.
  const signature = await ctx.connection.sendRawTransaction(bytes, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  await ctx.record(step, { status: "submitted", signature, ...latest });
  const result = await ctx.connection.confirmTransaction({ signature, ...latest }, "finalized");
  if (result.value.err) throw new Error("Deployment transaction failed atomically: " + step);
  await ctx.record(step, {
    status: "finalized",
    signature,
    slot: result.context.slot,
  });
  return signature;
}
export async function verifyAsset(ctx: ChainContext, asset: AssetPlan, reuseExisting = false) {
  const spec = ASSETS.find((a) => a.symbol === asset.symbol)!;
  const mintKey = key(asset.mint),
    program = tokenProgram(spec),
    owner = ctx.deployer.publicKey;
  if (JSON.stringify(assetPlan(spec, mintKey, owner)) !== JSON.stringify(asset))
    throw new Error("Asset plan differs from fixed fixture policy");
  const result = await ctx.connection.getMultipleAccountsInfoAndContext([mintKey, key(asset.ata)], {
    commitment: "finalized",
  });
  const mint = unpackMint(mintKey, result.value[0] ?? null, program);
  const expectedExtensions = isIssuer(spec) ? issuerExtensionTypes(spec.profile) : [];
  if (
    JSON.stringify(mintExtensions(mint.tlvData).sort((a, b) => a - b)) !==
    JSON.stringify(expectedExtensions)
  )
    throw new Error("Unexpected mock mint extension set");
  // Mock issuers keep the issuer's freeze authority (the deployer); others have none.
  if (
    !mint.isInitialized ||
    mint.decimals !== spec.decimals ||
    (isIssuer(spec) ? !mint.freezeAuthority?.equals(owner) : !!mint.freezeAuthority)
  )
    throw new Error("Mock mint initialization/decimals/freeze mismatch");
  if (isIssuer(spec)) {
    const issuer = decodeSupportedMint(mintKey, result.value[0] ?? null).issuer;
    if (issuer.controls !== ISSUERS[spec.profile].admitted || issuer.paused || issuer.transferHookProgram)
      throw new Error("Mock issuer controls differ from the replicated issuer configuration");
  }
  if (spec.kind === "native") {
    if (!mintKey.equals(NATIVE_MINT) || mint.mintAuthority)
      throw new Error("SOL must be canonical wrapped native SOL");
  } else if (
    !mint.mintAuthority?.equals(owner) ||
    (!reuseExisting && mint.supply > BigInt(asset.initialRaw))
  ) {
    throw new Error("Mock mint authority or issuance differs from the one-time allocation");
  }
  const account = result.value[1] ? unpackAccount(key(asset.ata), result.value[1]!, program) : null;
  if (
    account &&
    (!account.owner.equals(owner) ||
      !account.mint.equals(mintKey) ||
      !account.isInitialized ||
      account.isFrozen ||
      account.delegate ||
      account.closeAuthority ||
      account.isNative !== (spec.kind === "native"))
  )
    throw new Error("Deployer token account identity/authority mismatch");
  // A user may have transferred, burned or unwrapped their allocation since
  // deployment. Verification reports current balance; it does not remint/top up.
  if (isIssuer(spec)) {
    const pointer = getMetadataPointerState(mint),
      metadata = await getTokenMetadata(ctx.connection, mintKey, "finalized", program);
    if (
      !pointer?.metadataAddress?.equals(mintKey) ||
      !pointer.authority?.equals(owner) ||
      !metadata?.mint.equals(mintKey) ||
      !metadata.updateAuthority?.equals(owner) ||
      metadata.name !== asset.name ||
      metadata.symbol !== asset.metadataSymbol ||
      metadata.uri !== asset.metadataUri ||
      metadata.additionalMetadata.length
    )
      throw new Error("Mock Token-2022 metadata mismatch");
    const fees = getTransferFeeConfig(mint);
    if (
      spec.feeBps
        ? !fees ||
          !fees.transferFeeConfigAuthority?.equals(owner) ||
          !fees.withdrawWithheldAuthority?.equals(owner) ||
          [fees.olderTransferFee, fees.newerTransferFee].some(
            (f) =>
              f.transferFeeBasisPoints !== spec.feeBps ||
              // Replicas copy the issuers' uncapped fee (PreStocks, Tessera).
              f.maximumFee !== (1n << 64n) - 1n,
          )
        : !!fees
    )
      throw new Error("Mock Token-2022 fee policy mismatch");
  }
  return {
    ...asset,
    currentRawBalance: (account?.amount ?? 0n).toString(),
    currentSupply: mint.supply.toString(),
    tokenAccountExists: !!account,
    slot: result.context.slot,
  };
}
export async function initializeAssets(
  ctx: ChainContext,
  plan: DeploymentPlan,
  mintSigners: Map<string, Keypair>,
  completed: Set<string>,
) {
  for (const spec of ASSETS) {
    await ctx.assertNetwork();
    const asset = plan.assets.find((a) => a.symbol === spec.symbol)!;
    const marker = spec.kind === "native" ? key(asset.ata) : key(asset.mint);
    const exists = await ctx.connection.getAccountInfo(marker, "finalized");
    if (plan.reuseExistingAssets) {
      if (!exists) throw new Error("Configured reusable Devnet asset is missing");
      const verified = await verifyAsset(ctx, asset, true);
      if (!verified.tokenAccountExists)
        throw new Error("Reusable Devnet asset requires the deployer token account");
      if (!completed.has("asset:" + spec.symbol))
        await ctx.record("asset:" + spec.symbol, {
          status: "recovered",
          slot: verified.slot,
          reusedExisting: true,
        });
      continue;
    }
    if (!exists && !completed.has("asset:" + spec.symbol)) {
      const signer = mintSigners.get(spec.symbol) ?? null;
      const built = await assetInstructions(ctx, spec, signer);
      if (JSON.stringify(built.asset) !== JSON.stringify(asset))
        throw new Error("Mint signer differs from prepared plan");
      await sendStep(ctx, "asset:" + spec.symbol, built.instructions, signer ? [signer] : []);
    } else if (exists && !completed.has("asset:" + spec.symbol)) {
      // Recover an uncertain RPC response only from a fully initialized atomic
      // step, never from an empty or someone else's ATA.
      const verified = await verifyAsset(ctx, asset);
      if (
        !verified.tokenAccountExists ||
        verified.currentRawBalance !== asset.initialRaw ||
        (spec.kind !== "native" && verified.currentSupply !== asset.initialRaw)
      )
        throw new Error("Unrecorded token state cannot be safely adopted");
      await ctx.record("asset:" + spec.symbol, {
        status: "recovered",
        slot: verified.slot,
      });
    }
    await verifyAsset(ctx, asset);
  }
}
export function assertConfig(config: ConfigAccount, owner: PublicKey, quote: PublicKey) {
  if (
    !config.seed_authority.equals(owner) ||
    !config.admin.equals(owner) ||
    !config.quote_mint.equals(quote) ||
    config.paused ||
    !config.pending_admin.equals(PublicKey.default) ||
    config.admin_after.toString() !== "0" ||
    config.maker_bps ||
    config.taker_bps ||
    !Object.values(config.roles).every((k) => k.equals(owner))
  )
    throw new Error("Existing configuration differs from this Devnet staging deployment");
}
export async function initializeConfig(ctx: ChainContext, plan: DeploymentPlan) {
  const client = new SolanaClient({
    rpcUrl: ctx.connection.rpcEndpoint,
    config: plan.config,
    genesisHash: plan.genesisHash,
  });
  const quote = key(plan.assets.find((a) => a.symbol === "USDC")!.mint),
    owner = ctx.deployer.publicKey;
  await ctx.assertNetwork();
  if (!(await ctx.connection.getAccountInfo(configAddress(owner), "finalized"))) {
    await sendStep(ctx, "config", [
      client.ix(
        "initialize",
        {
          roles: {
            market_admin: owner,
            guardian: owner,
            resolution_admin: owner,
          },
        },
        {
          admin: owner,
          config: configAddress(owner),
          quote_mint: quote,
          system_program: SystemProgram.programId,
        },
      ),
    ]);
  }
  await verifyConfiguration(ctx, plan);
}
export async function verifyConfiguration(ctx: ChainContext, plan: DeploymentPlan) {
  const info = await ctx.connection.getAccountInfo(key(plan.config), "finalized");
  if (!info || !info.owner.equals(PROGRAM_ID) || info.executable)
    throw new Error("Missing or foreign finalized protocol configuration");
  assertConfig(
    coder.accounts.decode<ConfigAccount>("Config", info.data),
    ctx.deployer.publicKey,
    key(plan.assets.find((a) => a.symbol === "USDC")!.mint),
  );
}
