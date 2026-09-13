import { Buffer } from "buffer";
import { BorshCoder, BN, type Idl } from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idlJson from "./idl.json";

export { BN, PublicKey, SystemProgram, TOKEN_PROGRAM_ID };
export const PROGRAM_ID = new PublicKey("CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3");
export const coder = new BorshCoder(idlJson as Idl);
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const WAD = 10n ** 18n;
export const MAX_MAKERS = 8;
export const big = (value: BN | bigint | number | string): bigint => BigInt(value.toString());
export const bn = (value: BN | bigint | number | string): BN => new BN(value.toString());
export const key = (value: PublicKey | string): PublicKey => new PublicKey(value);
export function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a Solana public key");
  const parsed = new PublicKey(value);
  if (parsed.toBase58() !== value || parsed.equals(PublicKey.default))
    throw new Error("Invalid Solana public key");
  return value;
}
export function bytes32(value: string | Uint8Array): Buffer {
  const result =
    typeof value === "string" && /^0x[\da-fA-F]{64}$/.test(value)
      ? Buffer.from(value.slice(2), "hex")
      : typeof value !== "string"
        ? Buffer.from(value)
        : null;
  if (!result || result.length !== 32) throw new Error("Expected 32 bytes");
  return result;
}
export const hex = (value: Uint8Array | number[]): `0x${string}` =>
  `0x${Buffer.from(value).toString("hex")}`;
export const digest = (value: string) => sha256(new TextEncoder().encode(value));
export const pda = (seeds: (Uint8Array | Buffer)[], program = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
export const configAddress = (admin: PublicKey, program = PROGRAM_ID) =>
  pda([Buffer.from("config"), admin.toBuffer()], program);
export const marketAddress = (config: PublicKey, id: Uint8Array, program = PROGRAM_ID) =>
  pda([Buffer.from("market"), config.toBuffer(), bytes32(id)], program);
export const walletAddress = (market: PublicKey, owner: PublicKey, program = PROGRAM_ID) =>
  pda([Buffer.from("wallet"), market.toBuffer(), owner.toBuffer()], program);
export const traderAddress = (config: PublicKey, owner: PublicKey, program = PROGRAM_ID) =>
  pda([Buffer.from("trader"), config.toBuffer(), owner.toBuffer()], program);
export const orderAddress = (
  market: PublicKey,
  owner: PublicKey,
  salt: Uint8Array,
  program = PROGRAM_ID,
) => pda([Buffer.from("order"), market.toBuffer(), owner.toBuffer(), bytes32(salt)], program);
export const claimAddress = (market: PublicKey, asset: number, program = PROGRAM_ID) =>
  pda([Buffer.from("claim"), market.toBuffer(), Buffer.from([asset])], program);
export const vaultAddress = (market: PublicKey, asset: number, program = PROGRAM_ID) =>
  pda([Buffer.from("vault"), market.toBuffer(), Buffer.from([asset])], program);

export interface Roles {
  market_admin: PublicKey;
  guardian: PublicKey;
  resolution_admin: PublicKey;
}
export interface ConfigAccount {
  seed_authority: PublicKey;
  admin: PublicKey;
  quote_mint: PublicKey;
  roles: Roles;
  paused: boolean;
  maker_bps: number;
  taker_bps: number;
  pending_admin: PublicKey;
  admin_after: BN;
  bump: number;
}
export interface MarketTerms {
  condition: number[];
  yes_index: number;
  no_index: number;
  rules_hash: number[];
  metadata_hash: number[];
  metadata_uri: string;
  trading_open: BN;
  trading_cutoff: BN;
  tick: BN;
  step: BN;
  min_notional: BN;
  max_quantity: BN;
  max_order: BN;
  max_wallet: BN;
  max_market: BN;
}
export interface MarketAccount {
  config: PublicKey;
  id: number[];
  terms: MarketTerms;
  mints: PublicKey[];
  decimals: number[];
  vaults_initialized: number;
  state: number;
  sequence: BN[];
  open_notional: BN;
  credits: BN[];
  escrow: BN[];
  backing: BN[];
  fees: BN[];
  resolution_commitment: number[];
  payouts: number[];
  evidence: number[];
  evidence_uri: string;
  resolved_at: BN;
  bump: number;
}
export interface WalletAccount {
  market: PublicKey;
  owner: PublicKey;
  balances: BN[];
  open_notional: BN;
  bump: number;
}
export interface TraderAccount {
  config: PublicKey;
  owner: PublicKey;
  minimum_nonce: BN;
  bump: number;
}
export interface OrderTerms {
  recipient: PublicKey;
  salt: number[];
  quantity: BN;
  price: BN;
  expiry: BN;
  nonce: BN;
  max_fee_bps: number;
  branch: number;
  side: number;
  funding: number;
  tif: number;
}
export interface OrderAccount {
  market: PublicKey;
  owner: PublicKey;
  terms: OrderTerms;
  remaining: BN;
  filled: BN;
  reserved: BN;
  open_notional: BN;
  sequence: BN;
  fee_carry: number;
  status: number;
  bump: number;
}
export interface OrderWire {
  maker: string;
  recipient: string;
  marketId: string;
  salt: string;
  quantity: string;
  limitPriceRawX18: string;
  expiry: string;
  nonce: string;
  maxFeeBps: number;
  branch: number;
  side: number;
  fundingKind: number;
  tif: number;
}

export function unsigned(value: unknown, maximum = U64_MAX): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value))
    throw new Error("Invalid integer amount");
  const result = BigInt(value);
  if (result > maximum) throw new Error("Amount exceeds the supported integer range");
  return result;
}
export function parseOrder(value: unknown): OrderWire {
  if (!value || typeof value !== "object") throw new Error("Invalid order");
  const o = value as OrderWire;
  for (const field of [o.maker, o.recipient, o.marketId]) address(field);
  bytes32(o.salt);
  if (unsigned(o.quantity) === 0n || unsigned(o.limitPriceRawX18, U128_MAX) === 0n)
    throw new Error("Zero order size or price");
  unsigned(o.expiry, (1n << 63n) - 1n);
  unsigned(o.nonce);
  for (const field of [o.branch, o.side, o.fundingKind, o.tif])
    if (field !== 0 && field !== 1) throw new Error("Invalid order enum");
  if (!Number.isInteger(o.maxFeeBps) || o.maxFeeBps < 0 || o.maxFeeBps > 1_000)
    throw new Error("Invalid fee cap");
  return {
    maker: o.maker,
    recipient: o.recipient,
    marketId: o.marketId,
    salt: o.salt,
    quantity: o.quantity,
    limitPriceRawX18: o.limitPriceRawX18,
    expiry: o.expiry,
    nonce: o.nonce,
    maxFeeBps: o.maxFeeBps,
    branch: o.branch,
    side: o.side,
    fundingKind: o.fundingKind,
    tif: o.tif,
  };
}
export function orderTerms(order: OrderWire): OrderTerms {
  const o = parseOrder(order);
  return {
    recipient: key(o.recipient),
    salt: [...bytes32(o.salt)],
    quantity: bn(o.quantity),
    price: bn(o.limitPriceRawX18),
    expiry: bn(o.expiry),
    nonce: bn(o.nonce),
    max_fee_bps: o.maxFeeBps,
    branch: o.branch,
    side: o.side,
    funding: o.fundingKind,
    tif: o.tif,
  };
}
export function orderWire(order: OrderAccount): OrderWire {
  const t = order.terms;
  return {
    maker: order.owner.toBase58(),
    recipient: t.recipient.toBase58(),
    marketId: order.market.toBase58(),
    salt: hex(t.salt),
    quantity: t.quantity.toString(),
    limitPriceRawX18: t.price.toString(),
    expiry: t.expiry.toString(),
    nonce: t.nonce.toString(),
    maxFeeBps: t.max_fee_bps,
    branch: t.branch,
    side: t.side,
    fundingKind: t.funding,
    tif: t.tif,
  };
}
export const orderId = (o: OrderWire, program = PROGRAM_ID) =>
  orderAddress(key(o.marketId), key(o.maker), bytes32(o.salt), program).toBase58();
export const fundingAsset = (o: OrderWire): number =>
  o.fundingKind === 0 ? (o.side === 0 ? 1 : 0) : 2 + (o.side === 0 ? 2 : 0) + o.branch;
export function assertSignInChallenge(
  challenge: { challengeId: string; message: string },
  owner: string,
  deployment: { programId: string; config: string; genesisHash: string },
  origin: string,
  now = Date.now(),
) {
  const lines = challenge.message.split("\n");
  if (
    !/^[a-f0-9]{64}$/.test(challenge.challengeId) ||
    lines.length !== 8 ||
    lines[0] !== "Sign in to probabl" ||
    lines[1] !== "Origin: " + origin ||
    lines[2] !== "Solana genesis: " + deployment.genesisHash ||
    lines[3] !== "Program: " + deployment.programId ||
    lines[4] !== "Config: " + deployment.config ||
    lines[5] !== "Wallet: " + address(owner) ||
    lines[6] !== "Nonce: " + challenge.challengeId ||
    !lines[7]?.startsWith("Expires: ")
  )
    throw new Error("Sign-in challenge differs from this deployment.");
  const expiry = Date.parse(lines[7].slice(9));
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 150_000)
    throw new Error("Sign-in challenge is expired or has an invalid lifetime.");
}
export function quote(quantity: bigint, price: bigint, up = false): bigint {
  if (quantity < 0n || quantity > U64_MAX || price < 0n || price > U128_MAX)
    throw new Error("Invalid price/quantity");
  const product = quantity * price;
  const result = product / WAD + (up && product % WAD !== 0n ? 1n : 0n);
  if (result > U64_MAX) throw new Error("Quote exceeds SPL amount range");
  return result;
}

export function instruction(
  name: string,
  args: Record<string, unknown>,
  accounts: Record<string, PublicKey>,
  remaining: AccountMeta[] = [],
  program = PROGRAM_ID,
): TransactionInstruction {
  const spec = (idlJson as Idl).instructions.find((i) => i.name === name);
  if (!spec) throw new Error(`Unknown instruction ${name}`);
  const keys = spec.accounts.map((item) => {
    if ("accounts" in item) throw new Error("Nested IDL accounts are not supported");
    const pubkey = accounts[item.name] ?? (item.address ? key(item.address) : undefined);
    if (!pubkey) throw new Error(`Missing account ${item.name}`);
    return { pubkey, isSigner: item.signer ?? false, isWritable: item.writable ?? false };
  });
  return new TransactionInstruction({
    programId: program,
    keys: [...keys, ...remaining],
    data: coder.instruction.encode(name, args),
  });
}
export function resolutionHash(
  config: PublicKey,
  market: PublicKey,
  yes: number,
  no: number,
  evidence: Uint8Array,
  uri: string,
  program = PROGRAM_ID,
) {
  if (
    ![
      [1, 0],
      [0, 1],
      [1, 1],
    ].some((p) => p[0] === yes && p[1] === no)
  )
    throw new Error("Invalid payout");
  return sha256(
    Buffer.concat([
      Buffer.from("PROBABL_SOLANA_RESOLUTION_V1"),
      program.toBuffer(),
      config.toBuffer(),
      market.toBuffer(),
      Buffer.from([yes, no]),
      bytes32(evidence),
      Buffer.from(digest(uri)),
    ]),
  );
}
