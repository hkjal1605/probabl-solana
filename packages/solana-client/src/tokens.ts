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
export const SUPPORTED_MINT_EXTENSIONS = new Set([1, 18, 19, 20, 21, 22, 23]);

export function tokenProgram(owner: PublicKey): PublicKey {
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID))
    throw new Error("Mint/account is not owned by SPL Token or Token-2022");
  return owner;
}

/** Strict TLV framing: unknown types, duplicate entries and truncated values
 * must not silently become an unrestricted mint. Zero-filled allocation padding
 * is permitted, as it is by the Token-2022 program. */
export function mintExtensions(data: Buffer): number[] {
  const extensions: number[] = [];
  for (let offset = 0; offset < data.length; ) {
    if (data.subarray(offset).every((byte) => byte === 0)) break;
    if (offset + 4 > data.length)
      throw new Error("Truncated mint extension header");
    const type = data.readUInt16LE(offset),
      length = data.readUInt16LE(offset + 2);
    if (!SUPPORTED_MINT_EXTENSIONS.has(type))
      throw new Error(
        `Unsupported Token-2022 mint extension ${type}: issuer integration required`,
      );
    if (extensions.includes(type) || offset + 4 + length > data.length)
      throw new Error("Duplicate or truncated mint extension");
    extensions.push(type);
    offset += 4 + length;
  }
  return extensions;
}

export function decodeSupportedMint(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
) {
  if (!info) throw new Error("Mint is missing");
  const program = tokenProgram(info.owner),
    mint = unpackMint(address, info, program);
  if (!mint.isInitialized) throw new Error("Mint is not initialized");
  const extensions = mintExtensions(mint.tlvData);
  // Validate the fixed-size fee payload now, before transaction construction.
  getTransferFeeConfig(mint);
  return { ...mint, program, extensions };
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
