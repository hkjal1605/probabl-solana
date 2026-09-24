/** Local/devnet mock issuer tokens that replicate the Token-2022 configuration
 * of real tokenized-stock issuers (read from mainnet on 2026-09-23, see
 * packages/solana-client/test/fixtures and docs/multi-issuer-markets.md).
 *
 * Every mock is built with the real Token-2022 program instructions, in the
 * same extension order as the mainnet mint, so the protocol's issuer admission
 * and live-state checks (pause, ScaledUiAmount multiplier, default account
 * state, unset transfer hook) run against genuine extension data. The mock
 * authority controls pause, multiplier updates and freezing: it is a test
 * double of the issuer, never a real issuer key. */
import {
  AccountState,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMintToCheckedInstruction,
  createPauseInstruction,
  createResumeInstruction,
  createUpdateMultiplierDataInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

export type IssuerProfile = "xstocks" | "ondo" | "remora" | "backpack";

/** Issuer-control extensions (plus the generic metadata pair), in mainnet order. */
type Control =
  | "metadataPointer"
  | "permanentDelegate"
  | "defaultAccountState"
  | "scaledUiAmount"
  | "pausable"
  | "confidentialTransfer"
  | "transferHook";

export interface IssuerSpec {
  label: string;
  /** Mainnet symbol suffix, e.g. NVDA + "x". */
  suffix: string;
  decimals: number;
  /** Exact admission mask (docs/multi-issuer-markets.md). */
  admitted: number;
  /** Realistic effective ScaledUiAmount multiplier (dividends reinvested). */
  multiplier: number;
  controls: readonly Control[];
}

export const ISSUERS: Record<IssuerProfile, IssuerSpec> = {
  // NVDAx Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
  xstocks: {
    label: "xStocks",
    suffix: "x",
    decimals: 8,
    admitted: 63,
    multiplier: 1.001701196801074,
    controls: [
      "metadataPointer",
      "permanentDelegate",
      "defaultAccountState",
      "scaledUiAmount",
      "pausable",
      "confidentialTransfer",
      "transferHook",
    ],
  },
  // NVDAon gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo
  ondo: {
    label: "Ondo Global Markets",
    suffix: "on",
    decimals: 9,
    admitted: 62,
    multiplier: 1.0017152487959897,
    controls: [
      "scaledUiAmount",
      "metadataPointer",
      "pausable",
      "defaultAccountState",
      "confidentialTransfer",
      "transferHook",
    ],
  },
  // NVDAr ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu
  remora: {
    label: "Remora",
    suffix: "r",
    decimals: 9,
    admitted: 47,
    multiplier: 1,
    controls: [
      "metadataPointer",
      "scaledUiAmount",
      "pausable",
      "permanentDelegate",
      "defaultAccountState",
      "confidentialTransfer",
    ],
  },
  // SPCX SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb
  backpack: {
    label: "Backpack Securities",
    suffix: "bp",
    decimals: 6,
    admitted: 63,
    multiplier: 1,
    controls: [
      "metadataPointer",
      "permanentDelegate",
      "defaultAccountState",
      "pausable",
      "confidentialTransfer",
      "transferHook",
      "scaledUiAmount",
    ],
  },
};

const EXTENSION: Record<Control, ExtensionType> = {
  metadataPointer: ExtensionType.MetadataPointer,
  permanentDelegate: ExtensionType.PermanentDelegate,
  defaultAccountState: ExtensionType.DefaultAccountState,
  scaledUiAmount: ExtensionType.ScaledUiAmountConfig,
  pausable: ExtensionType.PausableConfig,
  confidentialTransfer: ExtensionType.ConfidentialTransferMint,
  transferHook: ExtensionType.TransferHook,
};

/** Token-2022 `ConfidentialTransferExtension::InitializeMint` (not exported by
 * @solana/spl-token 0.4.14): authority, auto-approve flag, no auditor. */
export function createInitializeConfidentialTransferMintInstruction(
  mint: PublicKey,
  authority: PublicKey | null,
  autoApprove = false,
  programId = TOKEN_2022_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(2 + 32 + 1 + 32);
  data[0] = 27; // TokenInstruction::ConfidentialTransferExtension
  data[1] = 0; // ConfidentialTransferInstruction::InitializeMint
  (authority ?? PublicKey.default).toBuffer().copy(data, 2);
  data[34] = autoApprove ? 1 : 0;
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

export interface MockIssuerOptions {
  connection: Connection;
  payer: PublicKey;
  /** Mock issuer authority: mint, freeze, pause, multiplier and metadata. */
  authority: PublicKey;
  profile: IssuerProfile;
  /** Underlying ticker, e.g. "NVDA"; the symbol becomes NVDA + suffix. */
  ticker: string;
  mint?: Keypair;
  decimals?: number;
  /** Effective multiplier at creation (defaults to the issuer's realistic one). */
  multiplier?: number;
  /** Optional generic TransferFeeConfig (bps, maximum raw fee) for fee-bearing
   * variants. Token-2022 rejects TransferFeeConfig next to ConfidentialTransferMint
   * unless ConfidentialTransferFeeConfig is also present, which the protocol does
   * not admit, so only profiles without confidential transfers accept a fee. */
  transferFee?: { bps: number; maximum: bigint };
  uri?: string;
}

export interface MockIssuer {
  mint: Keypair;
  profile: IssuerProfile;
  symbol: string;
  decimals: number;
  admitted: number;
  program: PublicKey;
  instructions: TransactionInstruction[];
}

/** One atomic transaction: account creation, extension initialization in the
 * issuer's order, InitializeMint2 and on-mint TokenMetadata. */
export async function mockIssuerInstructions(options: MockIssuerOptions): Promise<MockIssuer> {
  const spec = ISSUERS[options.profile];
  const mint = options.mint ?? Keypair.generate();
  const decimals = options.decimals ?? spec.decimals;
  const symbol = options.ticker + spec.suffix;
  if (options.transferFee && spec.controls.includes("confidentialTransfer"))
    throw new Error(
      `${spec.label} mints use ConfidentialTransferMint; Token-2022 requires an unadmitted confidential fee extension for a transfer fee`,
    );
  const program = TOKEN_2022_PROGRAM_ID;
  const key = mint.publicKey;
  const metadata = {
    mint: key,
    updateAuthority: options.authority,
    name: issuerMetadata(options.profile, options.ticker).name,
    symbol,
    uri: options.uri ?? "",
    additionalMetadata: [] as [string, string][],
  };
  const fixed = [
    ...spec.controls.map((control) => EXTENSION[control]),
    ...(options.transferFee ? [ExtensionType.TransferFeeConfig] : []),
  ];
  const space = getMintLen(fixed);
  const total = getMintLen(fixed, { [ExtensionType.TokenMetadata]: pack(metadata).length });
  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: options.payer,
      newAccountPubkey: key,
      space,
      lamports: await options.connection.getMinimumBalanceForRentExemption(total),
      programId: program,
    }),
  ];
  for (const control of spec.controls) {
    if (control === "metadataPointer")
      instructions.push(createInitializeMetadataPointerInstruction(key, options.authority, key, program));
    else if (control === "permanentDelegate")
      instructions.push(createInitializePermanentDelegateInstruction(key, options.authority, program));
    else if (control === "defaultAccountState")
      instructions.push(createInitializeDefaultAccountStateInstruction(key, AccountState.Initialized, program));
    else if (control === "scaledUiAmount")
      instructions.push(
        createInitializeScaledUiAmountConfigInstruction(
          key,
          options.authority,
          options.multiplier ?? spec.multiplier,
          program,
        ),
      );
    else if (control === "pausable")
      instructions.push(createInitializePausableConfigInstruction(key, options.authority, program));
    else if (control === "confidentialTransfer")
      instructions.push(createInitializeConfidentialTransferMintInstruction(key, options.authority, false, program));
    else instructions.push(createInitializeTransferHookInstruction(key, options.authority, PublicKey.default, program));
  }
  if (options.transferFee)
    instructions.push(
      createInitializeTransferFeeConfigInstruction(
        key,
        options.authority,
        options.authority,
        options.transferFee.bps,
        options.transferFee.maximum,
        program,
      ),
    );
  instructions.push(
    createInitializeMint2Instruction(key, decimals, options.authority, options.authority, program),
    createInitializeInstruction({
      programId: program,
      metadata: key,
      updateAuthority: options.authority,
      mint: key,
      mintAuthority: options.authority,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    }),
  );
  return {
    mint,
    profile: options.profile,
    symbol,
    decimals,
    admitted: spec.admitted,
    program,
    instructions,
  };
}

/** Idempotent ATA plus MintToChecked for a mock issuer holder. */
export function issueInstructions(
  mint: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  program = TOKEN_2022_PROGRAM_ID,
) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, program),
    createMintToCheckedInstruction(mint, ata, authority, amount, decimals, [], program),
  ];
}

export const pauseIssuer = (mint: PublicKey, authority: PublicKey) =>
  createPauseInstruction(mint, authority, [], TOKEN_2022_PROGRAM_ID);
export const resumeIssuer = (mint: PublicKey, authority: PublicKey) =>
  createResumeInstruction(mint, authority, [], TOKEN_2022_PROGRAM_ID);
/** Schedule (or, with a past/current timestamp, apply) a new UI multiplier. */
export const updateIssuerMultiplier = (
  mint: PublicKey,
  authority: PublicKey,
  multiplier: number,
  effectiveAt: bigint,
) => createUpdateMultiplierDataInstruction(mint, authority, multiplier, effectiveAt, [], TOKEN_2022_PROGRAM_ID);

/** Token-2022 mint extension types of a mock issuer (fixed extensions plus
 * on-mint TokenMetadata), for identity verification of created mints. */
export function issuerExtensionTypes(profile: IssuerProfile, transferFee = false): number[] {
  return [
    ...ISSUERS[profile].controls.map((control) => EXTENSION[control] as number),
    ...(transferFee ? [ExtensionType.TransferFeeConfig as number] : []),
    ExtensionType.TokenMetadata as number,
  ].sort((a, b) => a - b);
}

/** Metadata name and symbol a mock issuer mint is created with. */
export function issuerMetadata(profile: IssuerProfile, ticker: string) {
  const spec = ISSUERS[profile];
  return { name: `${ticker} (mock ${spec.label})`, symbol: ticker + spec.suffix };
}
