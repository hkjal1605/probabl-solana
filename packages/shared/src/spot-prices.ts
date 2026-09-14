/** Product reference prices, never execution guarantees or contract funding/settlement
 * authority. The opt-in market maker separately reviews units and risk before using
 * these indicative observations to choose its own quotes. */
export const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const SPOT_MAX_AGE_SECONDS = 120;
export const SPOT_MAX_CACHE_AGE_SECONDS = 60;
export const SPOT_POLL_MS = 15_000;
export const SPOT_BATCH_SIZE = 50;

// Public mints in .local/devnet/plan.json. Never infer mappings from ticker metadata.
export const DEVNET_ASSET_MINTS = Object.freeze({
  USDC: "iTUCuHTUHKqWe3XhUc5J3dSjmDdNuQKYtQh8KDYZdDD",
  BTC: "DhC4rpPyVJRHJmNqhMXchqET2o87b6JV6ebfkqA5Ufv4",
  ETH: "H2RuZ1p2KBtKesz6kcnLvXhtVK74LAbTrWbH5phyeMkY",
  SOL: "So11111111111111111111111111111111111111112",
  TSLA: "DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC",
  NVDA: "8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u",
  SPY: "8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3",
});

// Issuer-published mainnet counterparts. Display aliases, not vault-support declarations.
export const MAINNET_REFERENCE_MINTS = Object.freeze({
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  SOL: "So11111111111111111111111111111111111111112",
  TSLA: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  NVDA: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  SPY: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
});
type Symbol = keyof typeof DEVNET_ASSET_MINTS;
const aliases = new Map<string, Symbol>(
  Object.entries(DEVNET_ASSET_MINTS).map(([s, m]) => [m, s as Symbol]),
);
aliases.set("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "USDC");
const ordinaryUnits = new Set<string>([
  MAINNET_REFERENCE_MINTS.USDC,
  MAINNET_REFERENCE_MINTS.SOL,
  MAINNET_REFERENCE_MINTS.BTC,
  MAINNET_REFERENCE_MINTS.ETH,
]);

export function isSolanaMint(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const c of value) decoded = decoded * 58n + BigInt(alphabet.indexOf(c));
  const leadingZeros = value.match(/^1*/)?.[0].length ?? 0;
  return leadingZeros + (decoded === 0n ? 0 : Math.ceil(decoded.toString(16).length / 2)) === 32;
}
export interface SpotMapping {
  mint: string;
  sourceMint: string | null;
  referenceSymbol: string | null;
  testAsset: boolean;
  /** Unreviewed/scaled token units may display a price, but must not value raw balances. */
  valuationCompatible: boolean;
}
export function spotMapping(genesisHash: string, mint: string): SpotMapping {
  const symbol = genesisHash === SOLANA_DEVNET_GENESIS ? aliases.get(mint) : undefined;
  const sourceMint = !isSolanaMint(mint)
    ? null
    : symbol
      ? MAINNET_REFERENCE_MINTS[symbol]
      : genesisHash === SOLANA_MAINNET_GENESIS
        ? mint
        : null;
  return {
    mint,
    sourceMint,
    referenceSymbol: symbol
      ? {
          BTC: "cbBTC",
          ETH: "ETH (Portal)",
          TSLA: "TSLAx",
          NVDA: "NVDAx",
          SPY: "SPYx",
          SOL: "SOL",
          USDC: "USDC",
        }[symbol]
      : null,
    testAsset: genesisHash !== SOLANA_MAINNET_GENESIS,
    valuationCompatible: sourceMint !== null && ordinaryUnits.has(sourceMint),
  };
}

export type SpotStatus =
  | "available"
  | "stale"
  | "age-unverified"
  | "unavailable"
  | "restricted"
  | "invalid"
  | "not-configured"
  | "unmapped";
export interface SpotPrice extends SpotMapping {
  status: SpotStatus;
  /** Jupiter's numeric USD price, unchanged; NOT an exact execution or quote-token price. */
  priceUsd: number | null;
  sourceDecimals: number | null;
  blockId: number | null;
  /** Mainnet getBlockTime(blockId), never createdAt or the time we fetched Jupiter. */
  priceTimestamp: number | null;
  fetchedAt: number | null;
}
export interface SpotPricesResponse {
  source: "jupiter";
  sourceGenesisHash: typeof SOLANA_MAINNET_GENESIS;
  displayOnly: true;
  genesisHash: string;
  asOf: number;
  prices: SpotPrice[];
}

export function expireSpotPrice(price: SpotPrice, nowMs = Date.now()): SpotPrice {
  if (!["available", "age-unverified"].includes(price.status)) return price;
  const now = Math.floor(nowMs / 1000);
  if (
    price.fetchedAt === null ||
    price.fetchedAt > now + 5 ||
    now - price.fetchedAt > SPOT_MAX_CACHE_AGE_SECONDS ||
    (price.priceTimestamp !== null &&
      (price.priceTimestamp > now + 5 || now - price.priceTimestamp > SPOT_MAX_AGE_SECONDS))
  )
    return { ...price, status: "stale" };
  return price.priceTimestamp === null ? { ...price, status: "age-unverified" } : price;
}

/** Floating point is allowed only at the display boundary, never for token amounts. */
export function spotUsdValue(price: SpotPrice | undefined, nowMs = Date.now()): number | null {
  if (!price || !price.valuationCompatible || expireSpotPrice(price, nowMs).status !== "available")
    return null;
  return typeof price.priceUsd === "number" && Number.isFinite(price.priceUsd) && price.priceUsd > 0
    ? price.priceUsd
    : null;
}
