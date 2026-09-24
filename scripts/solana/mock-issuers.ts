/** Local/devnet replicas of real tokenized-stock and pre-IPO issuer tokens:
 * xStocks, Ondo Global Markets, PreStocks and Tessera (plus Remora and
 * Backpack configurations used by tests). Read from mainnet on 2026-09-23/25,
 * see packages/solana-client/test/fixtures and packages/shared/src/token-catalog.ts.
 *
 * Every replica is built with the real Token-2022 program instructions, in the
 * same extension order as the mainnet mint, so the protocol's issuer admission
 * and live-state checks (pause, ScaledUiAmount multiplier, default account
 * state, unset transfer hook, transfer fees) run against genuine extension
 * data. Its TokenMetadata carries the mainnet token's exact name, symbol and
 * metadata uri, so wallets and the UI show the issuer's own name, logo and
 * description. The replica authority controls pause, multiplier updates and
 * freezing: it is a test double of the issuer, never a real issuer key. */
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
import { type IssuerName, catalogTokensForAsset } from "../../packages/shared/src/token-catalog.ts";

export type IssuerProfile = "xstocks" | "ondo" | "prestocks" | "tessera" | "remora" | "backpack";

/** A mint extension of the issuer's layout, in mainnet order: issuer controls,
 * the generic transfer fee and the metadata pointer (TokenMetadata is last). */
type Control =
  | "metadataPointer"
  | "permanentDelegate"
  | "defaultAccountState"
  | "scaledUiAmount"
  | "pausable"
  | "confidentialTransfer"
  | "confidentialTransferFee"
  | "transferFee"
  | "transferHook";

export interface IssuerSpec {
  label: string;
  /** Catalog issuer whose mainnet identity replicas take (packages/shared). */
  issuer?: IssuerName;
  /** Fallback symbol for tickers outside the catalog: ticker + suffix. */
  suffix: string;
  decimals: number;
  /** Exact admission mask (docs/multi-issuer-markets.md). */
  admitted: number;
  /** Fallback effective ScaledUiAmount multiplier for tickers outside the catalog. */
  multiplier: number;
  /** Fallback transfer fee (bps) for a layout with a transfer fee. */
  feeBps?: number;
  controls: readonly Control[];
}

export const ISSUERS: Record<IssuerProfile, IssuerSpec> = {
  // NVDAx Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
  xstocks: {
    label: "xStocks",
    issuer: "xStocks",
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
    issuer: "Ondo Global Markets",
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
  // OPENAI PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF: every issuer control plus
  // a transfer fee, so Token-2022 also requires ConfidentialTransferFeeConfig.
  prestocks: {
    label: "PreStocks",
    issuer: "PreStocks",
    suffix: "",
    decimals: 9,
    admitted: 63,
    multiplier: 1,
    feeBps: 100,
    controls: [
      "permanentDelegate",
      "defaultAccountState",
      "transferFee",
      "confidentialTransfer",
      "confidentialTransferFee",
      "transferHook",
      "scaledUiAmount",
      "metadataPointer",
      "pausable",
    ],
  },
  // tOpenAI oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ: a generic fee token.
  tessera: {
    label: "Tessera",
    issuer: "Tessera",
    suffix: "",
    decimals: 9,
    admitted: 0,
    multiplier: 1,
    feeBps: 20,
    controls: ["transferFee", "metadataPointer"],
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

/** ConfidentialTransferFeeConfig (not in @solana/spl-token 0.4.14): authority
 * 32, withdraw-withheld ElGamal pubkey 32, harvest flag 1, withheld ciphertext 64. */
const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16;
const CONFIDENTIAL_TRANSFER_FEE_CONFIG_LEN = 129;
/** PreStocks' withdraw-withheld ElGamal public key (a public curve point),
 * reused so replicas carry a valid configuration. */
const PRESTOCKS_WITHHELD_ELGAMAL = Buffer.from(
  "6081d56ee42ad310ef5bc83cbd6d5e9da201c4876b9bbbfeec4c8488c6870e63",
  "hex",
);
const U64_MAX = (1n << 64n) - 1n;

const EXTENSION: Record<Control, number> = {
  metadataPointer: ExtensionType.MetadataPointer,
  permanentDelegate: ExtensionType.PermanentDelegate,
  defaultAccountState: ExtensionType.DefaultAccountState,
  scaledUiAmount: ExtensionType.ScaledUiAmountConfig,
  pausable: ExtensionType.PausableConfig,
  confidentialTransfer: ExtensionType.ConfidentialTransferMint,
  confidentialTransferFee: CONFIDENTIAL_TRANSFER_FEE_CONFIG,
  transferFee: ExtensionType.TransferFeeConfig,
  transferHook: ExtensionType.TransferHook,
};

/** Mint account size of a layout (spl-token cannot size extension 16). */
function layoutLen(layout: readonly Control[], metadataBytes?: number): number {
  const known = layout.filter((c) => c !== "confidentialTransferFee").map((c) => EXTENSION[c] as ExtensionType);
  const extra = layout.includes("confidentialTransferFee") ? 4 + CONFIDENTIAL_TRANSFER_FEE_CONFIG_LEN : 0;
  const base = getMintLen(known, metadataBytes === undefined ? {} : { [ExtensionType.TokenMetadata]: metadataBytes });
  return base + extra;
}

/** Token-2022 `ConfidentialTransferFeeExtension::InitializeConfidentialTransferFeeConfig`
 * (not exported by @solana/spl-token 0.4.14). */
export function createInitializeConfidentialTransferFeeConfigInstruction(
  mint: PublicKey,
  authority: PublicKey | null,
  withdrawWithheldElGamal = PRESTOCKS_WITHHELD_ELGAMAL,
  programId = TOKEN_2022_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(2 + 32 + 32);
  data[0] = 37; // TokenInstruction::ConfidentialTransferFeeExtension
  data[1] = 0; // ConfidentialTransferFeeInstruction::InitializeConfidentialTransferFeeConfig
  (authority ?? PublicKey.default).toBuffer().copy(data, 2);
  withdrawWithheldElGamal.copy(data, 34);
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

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
  /** Replica authority: mint, freeze, pause, multiplier, fees and metadata. */
  authority: PublicKey;
  profile: IssuerProfile;
  /** Underlying asset ticker, e.g. "NVDA" or "OPENAI". */
  ticker: string;
  mint?: Keypair;
  decimals?: number;
  /** Effective multiplier at creation (defaults to the mainnet token's). */
  multiplier?: number;
  /** Transfer fee (bps, maximum raw fee). Layouts with a fee default to the
   * mainnet token's rate with no maximum; other layouts gain a TransferFeeConfig
   * (plus ConfidentialTransferFeeConfig next to confidential transfers, as
   * Token-2022 requires) for fee-bearing test variants. */
  transferFee?: { bps: number; maximum: bigint };
  /** Metadata uri (defaults to the mainnet token's issuer-hosted JSON). */
  uri?: string;
}

export interface MockIssuer {
  mint: Keypair;
  profile: IssuerProfile;
  symbol: string;
  decimals: number;
  admitted: number;
  program: PublicKey;
  /** The TransferFeeConfig the mint carries, if any. */
  transferFee: { bps: number; maximum: bigint } | null;
  instructions: TransactionInstruction[];
}

/** The mainnet identity a replica of `ticker` takes, or a clearly labelled
 * mock identity for tickers the issuer does not publish. */
export function issuerMetadata(profile: IssuerProfile, ticker: string) {
  const spec = ISSUERS[profile];
  const token = spec.issuer
    ? catalogTokensForAsset(ticker).find((candidate) => candidate.issuer === spec.issuer)
    : undefined;
  if (token)
    return {
      name: token.name,
      symbol: token.symbol,
      uri: token.uri,
      multiplier: token.multiplier,
      feeBps: token.transferFeeBps,
      mainnetMint: token.mint as string | null,
    };
  return {
    name: `${ticker} (mock ${spec.label})`,
    symbol: profile === "tessera" ? `t${ticker}` : ticker + spec.suffix,
    uri: "",
    multiplier: spec.multiplier,
    feeBps: spec.feeBps ?? 0,
    mainnetMint: null as string | null,
  };
}

/** The replica's extension layout, including an optional added transfer fee. */
function layoutOf(profile: IssuerProfile, feeRequested: boolean): Control[] {
  const layout = [...ISSUERS[profile].controls];
  if (feeRequested && !layout.includes("transferFee")) {
    layout.push("transferFee");
    if (layout.includes("confidentialTransfer")) layout.push("confidentialTransferFee");
  }
  return layout;
}

/** One atomic transaction: account creation, extension initialization in the
 * issuer's order, InitializeMint2 and on-mint TokenMetadata. */
export async function mockIssuerInstructions(options: MockIssuerOptions): Promise<MockIssuer> {
  const spec = ISSUERS[options.profile];
  const identity = issuerMetadata(options.profile, options.ticker);
  const mint = options.mint ?? Keypair.generate();
  const decimals = options.decimals ?? spec.decimals;
  const layout = layoutOf(options.profile, Boolean(options.transferFee));
  const fee = layout.includes("transferFee")
    ? (options.transferFee ?? { bps: identity.feeBps, maximum: U64_MAX })
    : undefined;
  const program = TOKEN_2022_PROGRAM_ID;
  const key = mint.publicKey;
  const metadata = {
    mint: key,
    updateAuthority: options.authority,
    name: identity.name,
    symbol: identity.symbol,
    uri: options.uri ?? identity.uri,
    additionalMetadata: [] as [string, string][],
  };
  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: options.payer,
      newAccountPubkey: key,
      space: layoutLen(layout),
      lamports: await options.connection.getMinimumBalanceForRentExemption(layoutLen(layout, pack(metadata).length)),
      programId: program,
    }),
  ];
  for (const control of layout) {
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
          options.multiplier ?? identity.multiplier,
          program,
        ),
      );
    else if (control === "pausable")
      instructions.push(createInitializePausableConfigInstruction(key, options.authority, program));
    else if (control === "confidentialTransfer")
      instructions.push(createInitializeConfidentialTransferMintInstruction(key, options.authority, false, program));
    else if (control === "confidentialTransferFee")
      instructions.push(createInitializeConfidentialTransferFeeConfigInstruction(key, options.authority));
    else if (control === "transferFee")
      instructions.push(
        createInitializeTransferFeeConfigInstruction(
          key,
          options.authority,
          options.authority,
          fee!.bps,
          fee!.maximum,
          program,
        ),
      );
    else instructions.push(createInitializeTransferHookInstruction(key, options.authority, PublicKey.default, program));
  }
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
    symbol: identity.symbol,
    decimals,
    admitted: spec.admitted,
    program,
    transferFee: fee ?? null,
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

/** Token-2022 mint extension types of a replica (its layout plus on-mint
 * TokenMetadata), sorted, for identity verification of created mints. */
export function issuerExtensionTypes(profile: IssuerProfile, transferFee = false): number[] {
  return [
    ...layoutOf(profile, transferFee).map((control) => EXTENSION[control]),
    ExtensionType.TokenMetadata as number,
  ].sort((a, b) => a - b);
}

/** The replica's extension types in creation (mainnet TLV) order. */
export function issuerExtensionOrder(profile: IssuerProfile, transferFee = false): number[] {
  return [...layoutOf(profile, transferFee).map((control) => EXTENSION[control]), ExtensionType.TokenMetadata as number];
}
