import {
  type AssetPoolAccount,
  coder,
  decodeSupportedMint,
  issuerControlNames,
  key,
  MAX_BASES,
  multiplierValue,
  poolAddress,
  poolVaultAddress,
  type SolanaClient,
  TOKEN_PROGRAM_ID,
} from "@conditional-stocks/solana-client";
import type { AccountInfo, PublicKey } from "@solana/web3.js";

/** Default share precision: 6 decimals, the lowest of the supported issuers (Backpack). */
export const DEFAULT_SHARE_DECIMALS = 6;
export const MAX_SHARE_DECIMALS = 18;
/** Onchain `shareScale` bound: 10^(leg decimals - share decimals) must fit a u64. */
const MAX_SCALE_EXPONENT = 19;
const RPC_BATCH = 100;

export interface IssuerInfo {
  /** Issuer-control admission bits (ISSUER_CONTROLS); a new pool admits exactly these. */
  controls: number;
  controlNames: string[];
  paused: boolean;
  /** DefaultAccountState = frozen: new token accounts (including a pool vault) start frozen. */
  defaultFrozen: boolean;
  /** The TransferHook extension exists; its program is unset (a set hook is rejected while decoding). */
  transferHookExtension: boolean;
  /** Live ScaledUiAmount multiplier as f64 bits (decimal string), 1.0 without the extension. */
  multiplier: string;
  multiplierValue: number;
  nextMultiplier: { value: number; effectiveAt: string } | null;
}
export interface PoolInfo {
  /** Admission bits of the existing protocol pool, or null when it must still be created. */
  admitted: number | null;
  vault: string;
  vaultFrozen: boolean | null;
}
export interface MintInfo {
  address: string;
  decimals: number;
  standard: string;
  symbol: string | null;
  name: string | null;
  issuer: IssuerInfo;
  pool?: PoolInfo;
}
export type MintCheck =
  | { ok: true; mint: MintInfo }
  | { ok: false; address: string; error: string };

const TOKEN_ACCOUNT_STATE_OFFSET = 108;
const FROZEN = 2;
const TOKEN_2022_TLV_OFFSET = 166;

/** Token-2022 TokenMetadata (extension 19): update authority, mint, name, symbol, uri. */
export function mintMetadata(
  info: AccountInfo<Buffer> | null,
): { name: string; symbol: string } | null {
  if (!info || info.data.length <= TOKEN_2022_TLV_OFFSET) return null;
  const data = info.data;
  try {
    for (let offset = TOKEN_2022_TLV_OFFSET; offset + 4 <= data.length; ) {
      const type = data.readUInt16LE(offset),
        length = data.readUInt16LE(offset + 2);
      if (type === 0 && length === 0) break;
      if (type === 19) {
        let at = offset + 4 + 64;
        const end = offset + 4 + length;
        const text = () => {
          const size = data.readUInt32LE(at);
          if (at + 4 + size > end || size > 200) throw new Error("metadata");
          const value = data.subarray(at + 4, at + 4 + size).toString("utf8");
          at += 4 + size;
          return value.replace(/\0/g, "").trim();
        };
        const name = text(),
          symbol = text();
        return { name, symbol };
      }
      offset += 4 + length;
    }
  } catch {
    return null;
  }
  return null;
}

/** Custody-policy decode with issuer controls, as the program and the SDK admin module see it. */
export function inspectMint(
  address: string,
  info: AccountInfo<Buffer> | null,
  now: bigint,
  pool?: {
    pool: AccountInfo<Buffer> | null;
    vault: AccountInfo<Buffer> | null;
    program: PublicKey;
    vaultAddress: string;
  },
): MintInfo {
  const mint = decodeSupportedMint(key(address), info, undefined, now);
  const issuer = mint.issuer;
  const metadata = mintMetadata(info);
  let poolInfo: PoolInfo | undefined;
  if (pool) {
    let admitted: number | null = null,
      vaultFrozen: boolean | null = null;
    if (pool.pool) {
      if (!pool.pool.owner.equals(pool.program))
        throw new Error("Pool address is not owned by the program");
      admitted = (coder.accounts.decode("AssetPool", pool.pool.data) as AssetPoolAccount).admitted;
    }
    if (pool.vault && pool.vault.data.length > TOKEN_ACCOUNT_STATE_OFFSET)
      vaultFrozen = pool.vault.data[TOKEN_ACCOUNT_STATE_OFFSET] === FROZEN;
    poolInfo = { admitted, vault: pool.vaultAddress, vaultFrozen };
  }
  return {
    address,
    decimals: mint.decimals,
    standard: mint.program.equals(TOKEN_PROGRAM_ID) ? "SPL Token" : "Token-2022",
    symbol: metadata?.symbol || null,
    name: metadata?.name || null,
    issuer: {
      controls: issuer.controls,
      controlNames: issuerControlNames(issuer.controls),
      paused: issuer.paused,
      defaultFrozen: issuer.defaultFrozen,
      transferHookExtension: (issuer.controls & 16) !== 0,
      multiplier: String(issuer.multiplier),
      multiplierValue: multiplierValue(issuer.multiplier),
      nextMultiplier: issuer.nextMultiplier
        ? {
            value: multiplierValue(issuer.nextMultiplier.bits),
            effectiveAt: String(issuer.nextMultiplier.effectiveAt),
          }
        : null,
    },
    ...(poolInfo ? { pool: poolInfo } : {}),
  };
}

export async function accountsInfo(client: SolanaClient, keys: PublicKey[]) {
  const result: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += RPC_BATCH)
    result.push(
      ...(await client.connection.getMultipleAccountsInfo(
        keys.slice(i, i + RPC_BATCH),
        "confirmed",
      )),
    );
  return result;
}

/** Reads each issuer mint, its protocol pool and pool vault. Per-mint errors are returned, not thrown. */
export async function checkIssuerMints(
  client: SolanaClient,
  addresses: string[],
  nowMs = Date.now(),
) {
  const now = BigInt(Math.floor(nowMs / 1000));
  const mints = addresses.map(key),
    pools = mints.map((mint) => poolAddress(client.config, mint, client.program)),
    vaults = pools.map((pool) => poolVaultAddress(pool, client.program));
  const infos = await accountsInfo(client, [...mints, ...pools, ...vaults]);
  const n = addresses.length;
  return Object.fromEntries(
    addresses.map((address, i): [string, MintCheck] => {
      try {
        return [
          address,
          {
            ok: true,
            mint: inspectMint(address, infos[i] ?? null, now, {
              pool: infos[n + i] ?? null,
              vault: infos[2 * n + i] ?? null,
              program: client.program,
              vaultAddress: vaults[i]!.toBase58(),
            }),
          },
        ];
      } catch (error) {
        return [
          address,
          { ok: false, address, error: error instanceof Error ? error.message : "Unreadable mint" },
        ];
      }
    }),
  );
}

export function parseShareDecimals(value: string | number): number {
  const text = String(value).trim();
  if (!/^[0-9]{1,2}$/.test(text) || Number(text) > MAX_SHARE_DECIMALS)
    throw new Error(`Share decimals must be an integer from 0 to ${MAX_SHARE_DECIMALS}.`);
  return Number(text);
}

/** Largest share precision all legs support, capped at the 6-decimal default. */
export const defaultShareDecimals = (legs: Pick<MintInfo, "decimals">[]) =>
  Math.min(DEFAULT_SHARE_DECIMALS, ...legs.map((leg) => leg.decimals));

export const mintLabel = (mint: Pick<MintInfo, "address" | "symbol">) =>
  mint.symbol
    ? `${mint.symbol} (${mint.address.slice(0, 4)}…${mint.address.slice(-4)})`
    : mint.address;

/** Why one issuer token cannot be listed as a leg with this share precision (empty = listable). */
export function issuerLegProblems(mint: MintInfo, shareDecimals: number): string[] {
  const name = mintLabel(mint),
    problems: string[] = [];
  if (mint.decimals < shareDecimals)
    problems.push(
      `${name} has ${mint.decimals} decimals, fewer than the market's ${shareDecimals} share decimals. Lower share decimals to at most ${mint.decimals}.`,
    );
  else if (mint.decimals - shareDecimals > MAX_SCALE_EXPONENT)
    problems.push(
      `${name} has too many decimals for ${shareDecimals} share decimals. Raise share decimals.`,
    );
  if (mint.issuer.paused)
    problems.push(
      `${name} is paused by its issuer. Paused tokens cannot be listed or traded until unpaused.`,
    );
  if (mint.issuer.defaultFrozen && mint.pool?.vaultFrozen !== false)
    problems.push(
      `${name} uses a frozen default account state: new token accounts, including the protocol pool vault ${mint.pool?.vault ?? ""}, start frozen. The issuer must allowlist and thaw that vault before this token can be listed.`,
    );
  if (mint.pool && mint.pool.admitted !== null && mint.pool.admitted !== mint.issuer.controls)
    problems.push(
      `${name}'s protocol pool admits issuer controls ${mint.pool.admitted}, but the mint now uses ${mint.issuer.controls}. The issuer configuration changed; review before listing.`,
    );
  return problems;
}

/** Validation of one asset market's ordered issuer legs. */
export function assetLegProblems(
  checks: MintCheck[],
  quote: string,
  shareDecimals: number,
): string[] {
  const problems: string[] = [];
  if (checks.length === 0 || checks.length > MAX_BASES)
    problems.push(`Each market lists 1 to ${MAX_BASES} issuer tokens of the same asset.`);
  const addresses = checks.map((check) => (check.ok ? check.mint.address : check.address));
  if (new Set(addresses).size !== addresses.length)
    problems.push("The same issuer token is listed twice in this market.");
  for (const check of checks) {
    if (!check.ok) {
      problems.push(`${check.address}: ${check.error}`);
      continue;
    }
    if (check.mint.address === quote)
      problems.push(
        `${check.mint.address} is the configured quote token and cannot be a base leg.`,
      );
    problems.push(...issuerLegProblems(check.mint, shareDecimals));
  }
  return problems;
}

/** Non-blocking notes shown next to a verified leg. */
export function issuerLegNotes(mint: MintInfo): string[] {
  const notes: string[] = [];
  if (mint.issuer.nextMultiplier)
    notes.push(
      `Scheduled multiplier ${mint.issuer.nextMultiplier.value} from ${new Date(Number(mint.issuer.nextMultiplier.effectiveAt) * 1000).toISOString()}.`,
    );
  if (mint.issuer.controls & 1)
    notes.push(
      "Permanent delegate: the issuer can move pooled tokens; a seizure halts only this pool.",
    );
  if (mint.issuer.defaultFrozen && mint.pool?.vaultFrozen === false)
    notes.push("Default-frozen mint; the existing pool vault is already thawed.");
  return notes;
}
