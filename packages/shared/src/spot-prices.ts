import { ISSUER_TOKEN_CATALOG, type IssuerName } from "./token-catalog.ts";

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
  USDC: "827noEu9yuV2HXiqFJhESUREcfkvA8RKXMxNKdVqxuvb",
  BTC: "9Lq6s3X22MTefov2hi9VtTRUbMaCahNpaQXmxtcu6H1S",
  ETH: "AxkdvS81zeZB62C6uWSUm2K5BUKeKvhR6upt1FnU6Hmi",
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
/** Whitelisted mainnet issuer tokens (base legs) per economic asset: the token
 * catalog (xStocks, Ondo, PreStocks, Tessera; packages/shared/src/token-catalog.ts)
 * plus Remora's NVDAr. A multi-issuer market trades several of these for one
 * asset in one order book. Scaled tokens carry a Token-2022 ScaledUiAmount
 * multiplier whose UI amount is `raw / 10^decimals * multiplier` economic
 * shares. Issuer metadata here is display and valuation identity only, never
 * custody or listing authority (that is the market's on-chain leg list). */
export interface IssuerToken {
  mint: string;
  /** Issuer ticker, e.g. "NVDAx", "OPENAI", "tOpenAI". */
  symbol: string;
  issuer: IssuerName | "Remora";
  /** Economic asset the token tracks, e.g. "NVDA" or "OPENAI". */
  asset: string;
  decimals: number;
  /** Carries a ScaledUiAmount multiplier (dividends/corporate actions/splits). */
  scaledUiAmount: boolean;
}
export const MAINNET_ISSUER_TOKENS: readonly IssuerToken[] = Object.freeze(
  [
    ...ISSUER_TOKEN_CATALOG.map((token) => ({
      mint: token.mint,
      symbol: token.symbol,
      issuer: token.issuer as IssuerToken["issuer"],
      asset: token.asset,
      decimals: token.decimals,
      // Tessera mints have no ScaledUiAmount extension.
      scaledUiAmount: token.issuer !== "Tessera",
    })),
    {
      mint: "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu",
      symbol: "NVDAr",
      issuer: "Remora" as const,
      asset: "NVDA",
      decimals: 9,
      scaledUiAmount: true,
    },
  ].map((token) => Object.freeze(token)),
);
const issuerTokens = new Map(MAINNET_ISSUER_TOKENS.map((token) => [token.mint, token]));
/** Mainnet issuer token identity of a (mainnet) mint, if whitelisted here. */
export function issuerToken(mint: string): IssuerToken | undefined {
  return issuerTokens.get(mint);
}
/** Every whitelisted issuer token of one economic asset (e.g. "NVDA"). */
export function issuerTokensForAsset(asset: string): IssuerToken[] {
  return MAINNET_ISSUER_TOKENS.filter((token) => token.asset === asset);
}
/** Devnet issuer replicas (scripts/solana/mock-issuers.ts) by symbol and the
 * mainnet token each one replicates exactly. */
export const DEVNET_ISSUER_MOCK_SOURCES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(ISSUER_TOKEN_CATALOG.map((token) => [token.symbol, token.mint])),
);
export type DevnetIssuerMock = string;
/** Replica mint -> mainnet source mint, for a given set of replica mints. */
export function devnetIssuerAliases(
  mints: Readonly<Record<string, string | undefined>>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [symbol, mint] of Object.entries(mints))
    if (mint && DEVNET_ISSUER_MOCK_SOURCES[symbol]) result.set(mint, DEVNET_ISSUER_MOCK_SOURCES[symbol]);
  return result;
}
let issuerAliases = new Map<string, string>();
/** Registers this deployment's devnet replica mints (symbol -> devnet mint),
 * as exported by the deployment scripts (`SOLANA_ISSUER_REPLICA_MINTS`, parsed
 * with `parseReplicaMints`). Explicit entries only; never inferred from metadata. */
export function configureDevnetIssuerReplicas(mints: Readonly<Record<string, string>>) {
  issuerAliases = devnetIssuerAliases(mints);
}
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
  /** Economic asset of a whitelisted issuer token (e.g. "NVDA"), else null. */
  asset?: string | null;
  /** Issuer of a whitelisted issuer token (e.g. "Ondo Global Markets"), else null. */
  issuer?: string | null;
  /** The source token carries a ScaledUiAmount multiplier: convert with
   * `sharePriceUsd` before comparing issuers or valuing economic shares. */
  scaledUiAmount?: boolean;
}
export function spotMapping(genesisHash: string, mint: string): SpotMapping {
  const devnet = genesisHash === SOLANA_DEVNET_GENESIS;
  const symbol = devnet ? aliases.get(mint) : undefined;
  const mock = devnet && !symbol ? issuerAliases.get(mint) : undefined;
  const sourceMint = !isSolanaMint(mint)
    ? null
    : symbol
      ? MAINNET_REFERENCE_MINTS[symbol]
      : mock
        ? mock
        : genesisHash === SOLANA_MAINNET_GENESIS
          ? mint
          : null;
  const token = sourceMint ? issuerToken(sourceMint) : undefined;
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
      : (token?.symbol ?? null),
    testAsset: genesisHash !== SOLANA_MAINNET_GENESIS,
    valuationCompatible: sourceMint !== null && ordinaryUnits.has(sourceMint),
    asset: token?.asset ?? null,
    issuer: token?.issuer ?? null,
    scaledUiAmount: token?.scaledUiAmount ?? false,
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

/** USD per economic share of an issuer token, from its token price and the
 * issuer's live ScaledUiAmount multiplier (`LiveLeg.multiplierValue` /
 * `bases[].live.multiplierValue`; 1 for unscaled mints).
 *
 * Unit convention: Jupiter's `usdPrice` is treated as USD per whole *unscaled*
 * token, i.e. per `10^sourceDecimals` raw units — the unit swaps settle in and
 * the unit this module has always assumed (which is why scaled tokens are not
 * `valuationCompatible` for raw balances). One economic share is
 * `10^decimals / multiplier` raw units (see docs/multi-issuer-markets.md, Units),
 * so the per-share price is `usdPrice / multiplier`. This makes issuers of the
 * same asset comparable (NVDAx vs NVDAon vs NVDAr) and matches the protocol's
 * share-unit order book. Display/reference only; never settlement authority.
 * Returns null for unusable prices or multipliers. */
export function sharePriceUsd(
  price: SpotPrice | number | null | undefined,
  multiplier: number,
  nowMs = Date.now(),
): number | null {
  const usd =
    typeof price === "number"
      ? price
      : price && expireSpotPrice(price, nowMs).status === "available"
        ? price.priceUsd
        : null;
  if (
    typeof usd !== "number" ||
    !Number.isFinite(usd) ||
    usd <= 0 ||
    !Number.isFinite(multiplier) ||
    multiplier <= 0
  )
    return null;
  const value = usd / multiplier;
  return Number.isFinite(value) && value > 0 ? value : null;
}
