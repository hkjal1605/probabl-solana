import { Buffer } from "buffer";
import { type AccountInfo, type Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getTransferFeeConfig,
  getEpochFee,
  calculateFee,
  type TransferFee,
  type Mint,
} from "@solana/spl-token";

export { TOKEN_2022_PROGRAM_ID };
const U64_MAX = (1n << 64n) - 1n;
// Keep identical to programs/conditional-stocks/src/token_policy.rs.
/** Generic extensions accepted for any mint. */
export const SUPPORTED_MINT_EXTENSIONS = new Set([1, 18, 19, 20, 21, 22, 23]);
/** Issuer controls (Token-2022 extension type -> admission bit). A pool admits
 * a subset explicitly; the program re-checks their live state. */
export const ISSUER_CONTROLS = {
  permanentDelegate: 1,
  pausable: 2,
  defaultAccountState: 4,
  scaledUiAmount: 8,
  transferHook: 16,
  confidentialTransfer: 32,
} as const;
export const ISSUER_CONTROL_EXTENSIONS = new Map<number, number>([
  [12, ISSUER_CONTROLS.permanentDelegate],
  [26, ISSUER_CONTROLS.pausable],
  [6, ISSUER_CONTROLS.defaultAccountState],
  [25, ISSUER_CONTROLS.scaledUiAmount],
  [14, ISSUER_CONTROLS.transferHook],
  [4, ISSUER_CONTROLS.confidentialTransfer],
  // ConfidentialTransferFeeConfig: required by Token-2022 when confidential
  // transfers meet a transfer fee; only affects confidential balances.
  [16, ISSUER_CONTROLS.confidentialTransfer],
]);
export const ALL_ISSUER_CONTROLS = 63;
export function issuerControlNames(mask: number): string[] {
  return Object.entries(ISSUER_CONTROLS).filter(([, bit]) => mask & bit).map(([name]) => name);
}
/** 1.0f64 bits, as protocol.ts UNIT_MULTIPLIER (kept local to avoid a cycle). */
const UNIT_MULTIPLIER = 0x3ff0_0000_0000_0000n;

export function tokenProgram(owner: PublicKey): PublicKey {
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID))
    throw new Error("Mint/account is not owned by SPL Token or Token-2022");
  return owner;
}

/** Strict TLV framing: unknown types, duplicate entries and truncated values
 * must not silently become an unrestricted mint. Zero-filled allocation padding
 * is permitted, as it is by the Token-2022 program. Issuer controls are accepted
 * only when their admission bit is in `admitted`. */
export function mintExtensions(data: Buffer, admitted = ALL_ISSUER_CONTROLS): number[] {
  return mintTlv(data, admitted).map((entry) => entry.type);
}

function mintTlv(data: Buffer, admitted: number) {
  const entries: { type: number; value: Buffer }[] = [];
  for (let offset = 0; offset < data.length; ) {
    if (data.subarray(offset).every((byte) => byte === 0)) break;
    if (offset + 4 > data.length)
      throw new Error("Truncated mint extension header");
    const type = data.readUInt16LE(offset),
      length = data.readUInt16LE(offset + 2);
    const control = ISSUER_CONTROL_EXTENSIONS.get(type);
    if (!SUPPORTED_MINT_EXTENSIONS.has(type) && (control === undefined || (admitted & control) !== control))
      throw new Error(
        `Unsupported Token-2022 mint extension ${type}: issuer integration required`,
      );
    if (entries.some((e) => e.type === type) || offset + 4 + length > data.length)
      throw new Error("Duplicate or truncated mint extension");
    entries.push({ type, value: data.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return entries;
}

export interface IssuerState {
  /** Issuer-control categories present (admission bits). */
  controls: number;
  paused: boolean;
  /** Configured transfer hook program, if any (the protocol rejects one). */
  transferHookProgram: PublicKey | null;
  /** Effective ScaledUiAmount multiplier bits at `now` (1.0 when absent). */
  multiplier: bigint;
  /** Scheduled next multiplier, when one is pending after `now`. */
  nextMultiplier: { bits: bigint; effectiveAt: bigint } | null;
  /** Issuer default account state: new token accounts start frozen. */
  defaultFrozen: boolean;
}

/** Live issuer-control state, decoded exactly as token_policy.rs does. */
export function issuerState(tlv: Buffer, now = BigInt(Math.floor(Date.now() / 1000)), admitted = ALL_ISSUER_CONTROLS): IssuerState {
  const state: IssuerState = {
    controls: 0, paused: false, transferHookProgram: null,
    multiplier: UNIT_MULTIPLIER, nextMultiplier: null, defaultFrozen: false,
  };
  for (const { type, value } of mintTlv(tlv, admitted)) {
    const control = ISSUER_CONTROL_EXTENSIONS.get(type);
    if (control === undefined) continue;
    state.controls |= control;
    if (type === 26) {
      if (value.length < 33) throw new Error("Truncated pausable extension");
      state.paused = value[32] !== 0;
    } else if (type === 14) {
      if (value.length < 64) throw new Error("Truncated transfer hook extension");
      const program = new PublicKey(value.subarray(32, 64));
      state.transferHookProgram = program.equals(PublicKey.default) ? null : program;
    } else if (type === 25) {
      if (value.length < 56) throw new Error("Truncated scaled UI amount extension");
      const current = value.readBigUInt64LE(32),
        effectiveAt = value.readBigInt64LE(40),
        next = value.readBigUInt64LE(48);
      state.multiplier = now >= effectiveAt ? next : current;
      state.nextMultiplier = now < effectiveAt && next !== current ? { bits: next, effectiveAt } : null;
    } else if (type === 6) {
      if (value.length < 1) throw new Error("Truncated default account state extension");
      state.defaultFrozen = value[0] === 2;
    }
  }
  return state;
}

/** Decodes a custody-eligible mint. Issuer controls (up to `admitted`) are
 * accepted; a configured transfer hook is rejected as the program rejects it. */
export function decodeSupportedMint(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  admitted = ALL_ISSUER_CONTROLS,
  now = BigInt(Math.floor(Date.now() / 1000)),
) {
  if (!info) throw new Error("Mint is missing");
  const program = tokenProgram(info.owner),
    mint = unpackMint(address, info, program);
  if (!mint.isInitialized) throw new Error("Mint is not initialized");
  const extensions = mintExtensions(mint.tlvData, admitted);
  const issuer = issuerState(mint.tlvData, now, admitted);
  if (issuer.transferHookProgram)
    throw new Error("Issuer transfer hook is configured; custody transfers are halted until reviewed");
  // Validate the fixed-size fee payload now, before transaction construction.
  getTransferFeeConfig(mint);
  return { ...mint, program, extensions, issuer };
}

/** Custody transfers fail while an issuer has paused its token. */
export function assertTransferable(mint: { issuer: IssuerState; address: PublicKey }) {
  if (mint.issuer.paused) throw new Error(`Issuer has paused ${mint.address.toBase58()}; transfers are halted`);
}

export async function supportedMint(
  connection: Connection,
  address: PublicKey,
) {
  return decodeSupportedMint(
    address,
    await connection.getAccountInfo(address, "confirmed"),
  );
}

export async function currentTransferFee(connection: Connection, mint: Mint) {
  const config = getTransferFeeConfig(mint);
  return config
    ? getEpochFee(
        config,
        BigInt((await connection.getEpochInfo("confirmed")).epoch),
      )
    : null;
}

export function transferNet(gross: bigint, fee: TransferFee | null): bigint {
  if (gross < 0n || gross > U64_MAX)
    throw new Error("Transfer amount exceeds u64");
  if (
    fee &&
    (!Number.isInteger(fee.transferFeeBasisPoints) ||
      fee.transferFeeBasisPoints < 0 ||
      fee.transferFeeBasisPoints > 10_000 ||
      fee.maximumFee < 0n ||
      fee.maximumFee > U64_MAX)
  )
    throw new Error("Invalid issuer transfer fee");
  return gross - (fee ? calculateFee(fee, gross) : 0n);
}

/** Smallest u64 gross amount that supplies the requested spendable credit.
 * Binary search avoids inaccurate floating point and handles capped 100% fees. */
export function transferGross(net: bigint, fee: TransferFee | null): bigint {
  if (net < 0n || net > U64_MAX) throw new Error("Credit amount exceeds u64");
  if (transferNet(U64_MAX, fee) < net)
    throw new Error("Required credit cannot be funded within u64");
  let low = net,
    high = U64_MAX;
  while (low < high) {
    const middle = low + (high - low) / 2n;
    if (transferNet(middle, fee) >= net) high = middle;
    else low = middle + 1n;
  }
  return low;
}
