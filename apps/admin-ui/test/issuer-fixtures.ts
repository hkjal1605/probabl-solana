import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, TOKEN_PROGRAM_ID } from "@conditional-stocks/solana-client";
import type { AccountInfo } from "@solana/web3.js";
import { Buffer } from "buffer";

/** Real mainnet issuer mints (read 2026-09-23), shared with the SDK's multi-issuer tests. */
export const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
export const NVDAON = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";
export const NVDAR = "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu";
export const SPCX = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";
/** A time after every fixture's scheduled multiplier took effect. */
export const FIXTURE_NOW_MS = 1_790_000_000_000;

const fixtures = join(import.meta.dir, "../../../packages/solana-client/test/fixtures");

export function mintFixture(address: string): AccountInfo<Buffer> {
  const raw = JSON.parse(readFileSync(join(fixtures, `mint-${address}.json`), "utf8"));
  return {
    data: Buffer.from(raw.data, "base64"),
    owner: new PublicKey(raw.owner),
    lamports: raw.lamports,
    executable: false,
    rentEpoch: 0,
  };
}

/** Rewrites one Token-2022 TLV entry of a mint copy. */
export function withExtension(
  info: AccountInfo<Buffer>,
  type: number,
  edit: (value: Buffer) => void,
): AccountInfo<Buffer> {
  const data = Buffer.from(info.data);
  for (let offset = 166; offset + 4 <= data.length; ) {
    const t = data.readUInt16LE(offset),
      length = data.readUInt16LE(offset + 2);
    if (t === 0 && length === 0) break;
    if (t === type) edit(data.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return { ...info, data };
}
export const paused = (info: AccountInfo<Buffer>) =>
  withExtension(info, 26, (value) => {
    value[32] = 1;
  });
export const defaultFrozen = (info: AccountInfo<Buffer>) =>
  withExtension(info, 6, (value) => {
    value[0] = 2;
  });
export const hookSet = (info: AccountInfo<Buffer>) =>
  withExtension(info, 14, (value) => {
    PublicKey.unique().toBuffer().copy(value, 32);
  });

/** Plain SPL mint with the given decimals. */
export function splMint(decimals: number, owner = TOKEN_PROGRAM_ID): AccountInfo<Buffer> {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}

/** SPL token account (165 bytes) with state 1 = initialized or 2 = frozen. */
export function tokenAccount(state: 1 | 2, owner: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  data[108] = state;
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}
