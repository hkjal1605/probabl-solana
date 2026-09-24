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
export const PROGRAM_ID = new PublicKey("53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra");
export const coder = new BorshCoder(idlJson as Idl);
/** Account encoding with an adequately sized buffer. Anchor's
 * `coder.accounts.encode` writes into a fixed 1000-byte buffer, smaller than a
 * multi-issuer Market. Used by fixtures and replay tooling. */
export function encodeAccount(name: string, value: unknown): Buffer {
  const layouts = (coder.accounts as unknown as { accountLayouts: Map<string, { layout: { encode(v: unknown, b: Buffer): number } }> }).accountLayouts;
  const entry = layouts.get(name);
  if (!entry) throw new Error(`Unknown account: ${name}`);
  const buffer = Buffer.alloc(16_384);
  const length = entry.layout.encode(value, buffer);
  return Buffer.concat([coder.accounts.accountDiscriminator(name), buffer.subarray(0, length)]);
}
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const WAD = 10n ** 18n;
export const MAX_MAKERS = 8;

/** Base (issuer) legs per market; collateral 0 is the quote, 1..=MAX_BASES are legs. */
export const MAX_BASES = 3;
export const COLLATERALS = 1 + MAX_BASES;
/** Per collateral c: underlying 3c, YES claim 3c + 1, NO claim 3c + 2. */
export const ASSETS = 3 * COLLATERALS;
export const QUOTE = 0;
/** Remaining accounts per touched base leg in `place`. */
export const LEG_ACCOUNTS = 7;
export const underlyingAsset = (collateral: number) => 3 * collateral;
export const claimAsset = (collateral: number, branch: number) => 3 * collateral + 1 + branch;
export const collateralOf = (asset: number) => Math.floor(asset / 3);
export const isClaimAsset = (asset: number) =>
  Number.isInteger(asset) && asset >= 0 && asset < ASSETS && asset % 3 !== 0;
export const legBit = (collateral: number) => 1 << (collateral - 1);
/** Every listed leg of a market with `bases` legs. */
export const allLegs = (bases: number) => (1 << bases) - 1;
/** The single leg a sell order delivers, or null when the mask is not exactly one listed leg. */
export function singleBase(mask: number): number | null {
  if (!Number.isInteger(mask) || mask <= 0 || mask >= 1 << MAX_BASES || (mask & (mask - 1)) !== 0) return null;
  return 31 - Math.clz32(mask) + 1;
}
/** Collaterals of every leg in a mask, ascending. */
export function legsOf(mask: number): number[] {
  const result: number[] = [];
  for (let c = 1; c <= MAX_BASES; c++) if (mask & legBit(c)) result.push(c);
  return result;
}

/** `1.0f64` bits: the multiplier of every mint without ScaledUiAmount. */
export const UNIT_MULTIPLIER = 0x3ff0_0000_0000_0000n;
/** Exact decode of an issuer ScaledUiAmount multiplier (IEEE-754 bits) as
 * mantissa / 2^shift. Mirrors protocol_core::multiplier_parts. */
export function multiplierParts(bits: bigint): { mantissa: bigint; shift: bigint } {
  if (bits < 0n || bits > U64_MAX) throw new Error("Invalid multiplier bits");
  const exponent = (bits >> 52n) & 0x7ffn;
  if (bits >> 63n !== 0n || exponent === 0n || exponent === 0x7ffn) throw new Error("Invalid issuer multiplier");
  const mantissa = (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  const shift = 1075n - exponent;
  if (shift < 0n || shift > 63n) throw new Error("Issuer multiplier is out of range");
  return { mantissa, shift };
}
export function multiplierBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}
export function multiplierValue(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  return view.getFloat64(0, true);
}
/** Raw issuer units for `units` share units at `scale` and a live multiplier.
 * Deliveries round down, reservations up. Mirrors protocol_core::base_raw. */
export function baseRaw(units: bigint, scale: bigint, multiplier: bigint, up = false): bigint {
  const { mantissa, shift } = multiplierParts(multiplier);
  if (units < 0n || scale < 0n) throw new Error("Invalid share conversion");
  const tokens = units * scale;
  if (tokens > U64_MAX) throw new Error("Share conversion exceeds u64");
  const numerator = tokens << shift;
  const raw = numerator / mantissa + (up && numerator % mantissa !== 0n ? 1n : 0n);
  if (raw > U64_MAX) throw new Error("Share conversion exceeds u64");
  return raw;
}
/** Dividend band: 4/5 <= current / listing <= 5/4, exactly. Mirrors protocol_core::within_band. */
export function withinBand(listing: bigint, current: bigint): boolean {
  const l = multiplierParts(listing), c = multiplierParts(current);
  const cur = c.mantissa * (1n << l.shift), lst = l.mantissa * (1n << c.shift);
  return 4n * cur <= 5n * lst && 5n * cur >= 4n * lst;
}
/** Share units per whole economic share. */
export const shareScale = (legDecimals: number, shareDecimals: number) => {
  if (!Number.isInteger(legDecimals) || !Number.isInteger(shareDecimals) || legDecimals < shareDecimals || legDecimals - shareDecimals > 19)
    throw new Error("Base leg decimals are incompatible with the market share unit");
  return 10n ** BigInt(legDecimals - shareDecimals);
};
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
const NONCE_BOUND_SALT = Buffer.from("PRBLOv02");
/** Random identity with a permanently bound nonce, enabling safe rent recovery. */
export function orderSalt(nonce: bigint, entropy: Uint8Array): `0x${string}` {
  if (nonce < 0n || nonce > U64_MAX || entropy.length !== 32) throw new Error("Invalid order salt inputs");
  const salt = Buffer.from(entropy);
  NONCE_BOUND_SALT.copy(salt);
  salt.writeBigUInt64LE(nonce, 8);
  return hex(salt);
}
export function boundOrderNonce(salt: string | Uint8Array): bigint | null {
  const bytes = bytes32(salt);
  return bytes.subarray(0, 8).equals(NONCE_BOUND_SALT) ? bytes.readBigUInt64LE(8) : null;
}
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
export const delegationAddress = (config: PublicKey, owner: PublicKey, delegate: PublicKey, program = PROGRAM_ID) =>
  pda([Buffer.from("delegate"), config.toBuffer(), owner.toBuffer(), delegate.toBuffer()], program);
export interface TradingDelegateAccount {
  config: PublicKey; owner: PublicKey; delegate: PublicKey; market: PublicKey;
  epoch: BN; expires_at: BN; max_order_quote: BN; remaining_quote: BN;
  max_fee_bps: number; permissions: number; revoked: boolean; bump: number;
}
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
export const poolAddress = (config: PublicKey, mint: PublicKey, program = PROGRAM_ID) =>
  pda([Buffer.from("pool"), config.toBuffer(), mint.toBuffer()], program);
export const poolVaultAddress = (pool: PublicKey, program = PROGRAM_ID) =>
  pda([Buffer.from("pool-vault"), pool.toBuffer()], program);
export const assetCreditAddress = (pool: PublicKey, owner: PublicKey, program = PROGRAM_ID) =>
  pda([Buffer.from("asset-credit"), pool.toBuffer(), owner.toBuffer()], program);
export interface AssetPoolAccount { config: PublicKey; mint: PublicKey; token_program: PublicKey; liability: BN; decimals: number; bump: number; admitted: number; vault_bump: number }
export interface AssetCreditAccount { pool: PublicKey; owner: PublicKey; available: BN; bump: number }

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
  share_decimals: number;
  tick: BN;
  step: BN;
  min_notional: BN;
  max_quantity: BN;
  max_order: BN;
  max_wallet: BN;
  max_market: BN;
}
export interface BaseLegAccount {
  /** 10^(leg decimals - share decimals). */
  scale: BN;
  /** Listing ScaledUiAmount multiplier (f64 bits; 1.0 when absent). */
  multiplier: BN;
  active: boolean;
}
export interface MarketAccount {
  config: PublicKey;
  id: number[];
  terms: MarketTerms;
  bases: number;
  legs: BaseLegAccount[];
  /** ASSETS entries: underlying 3c, YES 3c+1, NO 3c+2. */
  mints: PublicKey[];
  /** Per collateral (0 = quote). */
  decimals: number[];
  pool_bumps: number[];
  vaults_initialized: number;
  state: number;
  sequence: BN[];
  /** Last RECENT placements per branch (branch b, sequence s at
   * b * RECENT + s % RECENT), limit prices in ticks; side 2 = did not rest. */
  recent: PlacementAccount[];
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
export interface PlacementAccount {
  ticks: BN;
  side: number;
}
/** Placements retained per branch for on-chain race checks. */
export const RECENT = 16;
/** A new market's retained placements (none rested yet). */
export const emptyRecent = (): PlacementAccount[] =>
  Array.from({ length: 2 * RECENT }, () => ({ ticks: new BN(0), side: 2 }));
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
  delegation_epoch: BN;
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
  bases: number;
}
export interface OrderAccount {
  market: PublicKey;
  owner: PublicKey;
  delegate: PublicKey;
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
  /** Signing key only; maker remains the beneficial owner of funds/positions. */
  delegate?: string;
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
  /** Base-leg bitmask (bit i = collateral i + 1). A buy accepts every leg in the
   * mask; a sell delivers exactly one leg. */
  bases: number;
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
  const bound = boundOrderNonce(o.salt);
  if (bound !== null && bound !== BigInt(o.nonce)) throw new Error("Order salt nonce differs");
  if (o.delegate !== undefined) {
    address(o.delegate);
    if (o.delegate === o.maker || o.recipient !== o.maker || bound !== BigInt(o.nonce))
      throw new Error("Invalid delegated order owner, recipient or nonce-bound salt");
  }
  for (const field of [o.branch, o.side, o.fundingKind, o.tif])
    if (field !== 0 && field !== 1) throw new Error("Invalid order enum");
  if (
    !Number.isInteger(o.bases) ||
    o.bases <= 0 ||
    o.bases >= 1 << MAX_BASES ||
    (o.side === 1 && singleBase(o.bases) === null)
  )
    throw new Error("Invalid base-leg selection: buys accept one or more legs, sells deliver exactly one");
  if (!Number.isInteger(o.maxFeeBps) || o.maxFeeBps < 0 || o.maxFeeBps > 1_000)
    throw new Error("Invalid fee cap");
  return {
    maker: o.maker,
    ...(o.delegate === undefined ? {} : {delegate: o.delegate}),
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
    bases: o.bases,
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
    bases: o.bases,
  };
}
export function orderWire(order: OrderAccount): OrderWire {
  const t = order.terms;
  return {
    maker: order.owner.toBase58(),
    ...(order.delegate.equals(PublicKey.default) ? {} : {delegate: order.delegate.toBase58()}),
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
    bases: t.bases,
  };
}
export const orderId = (o: OrderWire, program = PROGRAM_ID) =>
  orderAddress(key(o.marketId), key(o.maker), bytes32(o.salt), program).toBase58();
/** Collateral an order funds: the quote for buys, the delivered leg for sells. */
export function orderCollateral(o: Pick<OrderWire, "side" | "bases">): number {
  if (o.side === 0) return QUOTE;
  const leg = singleBase(o.bases);
  if (leg === null) throw new Error("Sell order must deliver exactly one base leg");
  return leg;
}
export const fundingAsset = (o: Pick<OrderWire, "side" | "bases" | "fundingKind" | "branch">): number => {
  const collateral = orderCollateral(o);
  return o.fundingKind === 0 ? underlyingAsset(collateral) : claimAsset(collateral, o.branch);
};
/** Whether a bid accepts (or an ask delivers) the given leg. */
export const acceptsLeg = (o: Pick<OrderWire, "bases">, collateral: number) =>
  collateral >= 1 && collateral <= MAX_BASES && (o.bases & legBit(collateral)) !== 0;
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
    const pubkey = accounts[item.name] ?? (item.address ? key(item.address) : item.optional ? program : undefined);
    if (!pubkey) throw new Error(`Missing account ${item.name}`);
    const absent = item.optional && pubkey.equals(program);
    return { pubkey, isSigner: absent ? false : item.signer ?? false, isWritable: absent ? false : item.writable ?? false };
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
