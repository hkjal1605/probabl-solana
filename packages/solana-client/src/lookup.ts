/** Operator-maintained address lookup tables. A placement names every maker's
 * order, wallet and trader PDA plus asset-credit frames; as 32-byte static keys
 * only ~1 maker fits a 1232-byte packet (5 with a static deployment table).
 * A keeper appends market and participant PDAs to append-only tables so each
 * reference costs one byte, and every protocol maker (MAX_MAKERS) fits. */
import { AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assetCreditAddress,
  claimAddress,
  claimAsset,
  delegationAddress,
  poolAddress,
  poolVaultAddress,
  traderAddress,
  underlyingAsset,
  vaultAddress,
  walletAddress,
  PROGRAM_ID,
  type MarketAccount,
} from "./protocol.ts";

/** Addresses per lookup table (program limit). */
export const LOOKUP_TABLE_CAPACITY = 256;
/** Addresses per extend instruction: 20 keeps the extend transaction well under the packet limit. */
export const LOOKUP_EXTEND_CHUNK = 20;

/** Program-wide static accounts every placement or custody action uses. */
export function deploymentLookupAddresses(config: PublicKey, program = PROGRAM_ID): PublicKey[] {
  return [
    config,
    program,
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    ComputeBudgetProgram.programId,
  ];
}

/** A market's static accounts: the market, and per listed collateral its mint,
 * custody pool, pool vault and both claim mints and vaults. */
export function marketLookupAddresses(config: PublicKey, market: PublicKey, account: MarketAccount, program = PROGRAM_ID): PublicKey[] {
  const addresses = [market];
  for (let c = 0; c <= account.bases; c++) {
    const mint = account.mints[underlyingAsset(c)]!;
    if (mint.equals(PublicKey.default)) continue;
    const pool = poolAddress(config, mint, program);
    addresses.push(mint, pool, poolVaultAddress(pool, program));
    for (const branch of [0, 1]) {
      const asset = claimAsset(c, branch);
      if ((account.vaults_initialized & (1 << asset)) === 0) continue;
      addresses.push(claimAddress(market, asset, program), vaultAddress(market, asset, program));
    }
  }
  return addresses;
}

/** One participant's PDAs in one market: wallet, config-wide trader, a pool
 * credit frame per listed collateral, and any trading delegation grants. */
export function participantLookupAddresses(
  config: PublicKey,
  market: PublicKey,
  account: MarketAccount,
  owner: PublicKey,
  delegates: readonly PublicKey[] = [],
  program = PROGRAM_ID,
): PublicKey[] {
  const addresses = [walletAddress(market, owner, program), traderAddress(config, owner, program)];
  for (let c = 0; c <= account.bases; c++) {
    const mint = account.mints[underlyingAsset(c)]!;
    if (!mint.equals(PublicKey.default)) addresses.push(assetCreditAddress(poolAddress(config, mint, program), owner, program));
  }
  for (const delegate of delegates) addresses.push(delegationAddress(config, owner, delegate, program));
  return addresses;
}

export interface KeptTable {
  key: PublicKey;
  addresses: readonly PublicKey[];
  /** Tables that are deactivating or closed can no longer be extended or used. */
  active: boolean;
}

/** Append-only extension plan: which desired addresses are missing from every
 * active table, packed into the newest table with room, then new tables.
 * `create` counts tables to create; their extensions follow in `pending`. */
export function planLookupExtensions(tables: readonly KeptTable[], desired: readonly PublicKey[]) {
  const present = new Set(tables.filter((t) => t.active).flatMap((t) => t.addresses.map(String)));
  const missing: PublicKey[] = [];
  for (const address of desired)
    if (!present.has(address.toBase58())) {
      present.add(address.toBase58());
      missing.push(address);
    }
  const extend: { table: PublicKey; addresses: PublicKey[] }[] = [];
  let queue = missing;
  for (const table of tables) {
    if (!table.active || !queue.length) continue;
    const room = LOOKUP_TABLE_CAPACITY - table.addresses.length;
    if (room <= 0) continue;
    const batch = queue.slice(0, room);
    queue = queue.slice(batch.length);
    for (let i = 0; i < batch.length; i += LOOKUP_EXTEND_CHUNK)
      extend.push({ table: table.key, addresses: batch.slice(i, i + LOOKUP_EXTEND_CHUNK) });
  }
  const pending: PublicKey[][] = [];
  for (let i = 0; i < queue.length; i += LOOKUP_TABLE_CAPACITY) pending.push(queue.slice(i, i + LOOKUP_TABLE_CAPACITY));
  return { missing, extend, create: pending.length, pending };
}

export { AddressLookupTableProgram };
