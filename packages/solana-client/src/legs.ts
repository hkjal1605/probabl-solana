import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import {
  big,
  claimAsset,
  multiplierValue,
  poolAddress,
  poolVaultAddress,
  underlyingAsset,
  withinBand,
  PROGRAM_ID,
  type MarketAccount,
} from "./protocol.ts";
import { ALL_ISSUER_CONTROLS, decodeSupportedMint, type IssuerState } from "./tokens.ts";
import type { LegState } from "./planner.ts";

export type LegHalt =
  | "delisted"
  | "claims-uninitialized"
  | "issuer-paused"
  | "vault-frozen"
  | "corporate-action"
  | "transfer-hook"
  | "unreadable";

/** Live view of one base leg: listing data plus the issuer's current state. */
export interface LiveLeg extends LegState {
  collateral: number;
  mint: string;
  decimals: number;
  listingMultiplier: bigint;
  multiplierValue: number;
  active: boolean;
  ready: boolean;
  paused: boolean;
  vaultFrozen: boolean;
  /** Why new exposure is halted, or null when tradable. */
  halt: LegHalt | null;
  issuer: IssuerState | null;
}

/** Accounts to read for live leg state: [leg mints..., leg pool vaults...]. */
export function legAccounts(market: MarketAccount, config: PublicKey, program = PROGRAM_ID): PublicKey[] {
  const mints: PublicKey[] = [], vaults: PublicKey[] = [];
  for (let c = 1; c <= market.bases; c++) {
    const mint = market.mints[underlyingAsset(c)]!;
    mints.push(mint);
    vaults.push(poolVaultAddress(poolAddress(config, mint, program), program));
  }
  return [...mints, ...vaults];
}

/** Pure evaluation mirroring the program's `tradable` + `exposable` checks. */
export function legStates(
  market: MarketAccount,
  infos: readonly (AccountInfo<Buffer> | null)[],
  config: PublicKey,
  program = PROGRAM_ID,
  now = BigInt(Math.floor(Date.now() / 1000)),
): Record<number, LiveLeg> {
  const result: Record<number, LiveLeg> = {};
  const vaultKeys = legAccounts(market, config, program).slice(market.bases);
  for (let c = 1; c <= market.bases; c++) {
    const leg = market.legs[c - 1]!;
    const mint = market.mints[underlyingAsset(c)]!;
    const bits = (1 << underlyingAsset(c)) | (1 << claimAsset(c, 0)) | (1 << claimAsset(c, 1));
    const ready = (market.vaults_initialized & bits) === bits;
    const listing = big(leg.multiplier);
    let issuer: IssuerState | null = null, halt: LegHalt | null = null, vaultFrozen = false;
    try {
      issuer = decodeSupportedMint(mint, infos[c - 1] ?? null, ALL_ISSUER_CONTROLS, now).issuer;
    } catch (error) {
      halt = error instanceof Error && /transfer hook/.test(error.message) ? "transfer-hook" : "unreadable";
    }
    const vaultInfo = infos[market.bases + c - 1] ?? null;
    try {
      if (!vaultInfo) throw new Error("missing vault");
      vaultFrozen = unpackAccount(vaultKeys[c - 1]!, vaultInfo, vaultInfo.owner).isFrozen;
    } catch {
      halt ??= "unreadable";
    }
    const multiplier = issuer?.multiplier ?? listing;
    if (!halt) {
      if (!leg.active) halt = "delisted";
      else if (!ready) halt = "claims-uninitialized";
      else if (issuer!.paused) halt = "issuer-paused";
      else if (vaultFrozen) halt = "vault-frozen";
      else if (!withinBand(listing, multiplier)) halt = "corporate-action";
    }
    result[c] = {
      collateral: c,
      mint: mint.toBase58(),
      decimals: market.decimals[c]!,
      scale: big(leg.scale),
      multiplier,
      listingMultiplier: listing,
      multiplierValue: multiplierValue(multiplier),
      tradable: halt === null,
      active: leg.active,
      ready,
      paused: issuer?.paused ?? false,
      vaultFrozen,
      halt,
      issuer,
    };
  }
  return result;
}

export async function liveLegs(
  connection: Connection,
  market: MarketAccount,
  config: PublicKey,
  program = PROGRAM_ID,
  now?: bigint,
) {
  const infos = await connection.getMultipleAccountsInfo(legAccounts(market, config, program), "confirmed");
  return legStates(market, infos, config, program, now);
}
