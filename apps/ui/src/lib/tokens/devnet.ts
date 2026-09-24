// Temporary display-only aliases for the public mints in .local/devnet/plan.json,
// plus the issuer-published mainnet stock tokens a multi-issuer market can list.
// Never derive trading precision, issuer support, prices, or balances from this map.
import { DEVNET_ASSET_MINTS, SOLANA_DEVNET_GENESIS } from "@conditional-stocks/shared/spot-prices";
import {
  assetDisplayName,
  type CatalogToken,
  catalogToken,
  catalogTokensForAsset,
  ISSUER_TOKEN_CATALOG,
  parseReplicaMints,
} from "@conditional-stocks/shared/token-catalog";

export { SOLANA_DEVNET_GENESIS };

export interface TokenDisplayMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly image: string;
  /** Devnet test asset (as opposed to a real issuer token). */
  readonly devnet: boolean;
  /** Underlying asset ticker shared by every issuer token of one stock (e.g. NVDA). */
  readonly asset?: string;
  /** Token issuer (e.g. xStocks, Ondo Global Markets, PreStocks, Tessera). */
  readonly issuer?: string;
  /** The issuer's own description (its metadata JSON). */
  readonly description?: string;
}

const token = (symbol: string, name: string, asset?: string): TokenDisplayMetadata =>
  Object.freeze({
    symbol,
    name,
    image: `/tokens/devnet/${symbol.toLowerCase()}.svg`,
    devnet: true as const,
    ...(asset ? { asset } : {}),
  });

export const DEVNET_TOKEN_METADATA: Readonly<Record<string, TokenDisplayMetadata>> = Object.freeze({
  [DEVNET_ASSET_MINTS.USDC]: token("USDC", "USD Coin"),
  [DEVNET_ASSET_MINTS.BTC]: token("BTC", "Bitcoin"),
  [DEVNET_ASSET_MINTS.ETH]: token("ETH", "Ethereum"),
  [DEVNET_ASSET_MINTS.SOL]: token("SOL", "Wrapped SOL"),
  [DEVNET_ASSET_MINTS.TSLA]: token("TSLA", "Tesla", "TSLA"),
  [DEVNET_ASSET_MINTS.NVDA]: token("NVDA", "NVIDIA", "NVDA"),
  [DEVNET_ASSET_MINTS.SPY]: token("SPY", "SPDR S&P 500 ETF Trust", "SPY"),
});

/** Known issuer families. The symbol suffix convention is display-only. */
export const TOKEN_ISSUERS = Object.freeze({
  xStocks: "xStocks",
  ondo: "Ondo Global Markets",
  prestocks: "PreStocks",
  tessera: "Tessera",
  remora: "Remora",
  backpack: "Backpack Securities",
});

const issuerToken = (
  symbol: string,
  name: string,
  asset: string,
  issuer: string,
): TokenDisplayMetadata =>
  Object.freeze({
    symbol,
    name,
    image: `/tokens/devnet/${asset.toLowerCase()}.svg`,
    devnet: false as const,
    asset,
    issuer,
  });

/** Display identity of a mainnet issuer token: its own on-chain name and
 * symbol, the issuer's description and a bundled copy of the issuer's logo. */
const catalogDisplay = (token: CatalogToken): TokenDisplayMetadata =>
  Object.freeze({
    symbol: token.symbol,
    name: token.name,
    image: token.logo,
    devnet: false as const,
    asset: token.asset,
    issuer: token.issuer,
    description: token.description,
  });

/** Issuer-published mainnet tokens (packages/shared/src/token-catalog.ts), keyed by exact mint. */
export const ISSUER_TOKEN_METADATA: Readonly<Record<string, TokenDisplayMetadata>> = Object.freeze({
  ...Object.fromEntries(ISSUER_TOKEN_CATALOG.map((token) => [token.mint, catalogDisplay(token)])),
  ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu: issuerToken(
    "NVDAr",
    "NVIDIA (Remora)",
    "NVDA",
    TOKEN_ISSUERS.remora,
  ),
});

/**
 * Devnet replicas of mainnet issuer tokens (scripts/solana/mock-issuers.ts), keyed by
 * their deployment mint. The API publishes the deployment's `SYMBOL=mint` pairs at
 * /v1/tokens/replicas; NEXT_PUBLIC_SOLANA_ISSUER_REPLICA_MINTS is the build-time
 * fallback. Each replica displays exactly as the mainnet token it replicates. An
 * invalid list shows the plain fallback rather than a guess.
 */
export function replicaTokenMetadata(
  value: string | Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, TokenDisplayMetadata>> {
  let mints: Record<string, string>;
  try {
    mints = parseReplicaMints(
      typeof value === "object"
        ? Object.entries(value)
            .map(([symbol, mint]) => `${symbol}=${mint}`)
            .join(",")
        : value,
    );
  } catch {
    mints = {};
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(mints).map(([symbol, mint]) => [mint, catalogDisplay(catalogToken(symbol)!)]),
    ),
  );
}
export const REPLICA_TOKEN_METADATA = replicaTokenMetadata(
  process.env.NEXT_PUBLIC_SOLANA_ISSUER_REPLICA_MINTS,
);

export function devnetTokenMetadata(mint: string, genesisHash: string) {
  // chainId=1 is a compatibility key shared by all Solana environments, not a network check.
  if (genesisHash !== SOLANA_DEVNET_GENESIS || !Object.hasOwn(DEVNET_TOKEN_METADATA, mint))
    return undefined;
  return DEVNET_TOKEN_METADATA[mint];
}

/** Display metadata of an issuer, replica or devnet token. Issuer mints are unique
 * addresses on any cluster; replica mints come from this deployment's configuration. */
export function tokenMetadata(
  mint: string,
  genesisHash: string,
  replicas: Readonly<Record<string, TokenDisplayMetadata>> = REPLICA_TOKEN_METADATA,
): TokenDisplayMetadata | undefined {
  if (Object.hasOwn(ISSUER_TOKEN_METADATA, mint)) return ISSUER_TOKEN_METADATA[mint];
  if (Object.hasOwn(replicas, mint)) return replicas[mint];
  return devnetTokenMetadata(mint, genesisHash);
}

/** Display issuer of a token symbol: the catalog's, else the suffix/prefix
 * conventions (NVDAx, NVDAon, NVDAr, tOpenAI). Display only. */
export function issuerFromSymbol(symbol: string): string | null {
  const known = catalogToken(symbol);
  if (known) return known.issuer;
  if (/^t[A-Z][A-Za-z]*$/.test(symbol)) return TOKEN_ISSUERS.tessera;
  if (/^[A-Z.]+x$/.test(symbol)) return TOKEN_ISSUERS.xStocks;
  if (/^[A-Z.]+on$/.test(symbol)) return TOKEN_ISSUERS.ondo;
  if (/^[A-Z.]+r$/.test(symbol)) return TOKEN_ISSUERS.remora;
  return null;
}

export interface LegDisplay {
  metadata?: TokenDisplayMetadata;
  symbol: string;
  issuer: string | null;
}

const ASSET_NAMES: Readonly<Record<string, string>> = Object.freeze({
  NVDA: "NVIDIA",
  TSLA: "Tesla",
  SPY: "SPDR S&P 500 ETF Trust",
});
/** Icon of an economic asset: the bundled stock icon, else the company logo of
 * its first catalog token (pre-IPO companies, e.g. the PreStocks OpenAI logo). */
const assetImage = (asset: string) =>
  asset in ASSET_NAMES
    ? `/tokens/devnet/${asset.toLowerCase()}.svg`
    : (catalogTokensForAsset(asset)[0]?.logo ?? `/tokens/devnet/${asset.toLowerCase()}.svg`);

/**
 * Market display identity from its ordered base-leg mints. The asset ticker is the
 * shared underlying of the known legs; with no known leg the Polymarket asset hint is
 * kept. `assetKey` groups sibling markets of one event by asset (NVDA vs TSLA), never
 * by a single base mint, and never by the event-wide Polymarket hint.
 */
export function marketTokenDisplay(
  baseMints: readonly string[],
  quoteMint: string,
  genesisHash: string,
  fallbackTicker: string,
  replicas: Readonly<Record<string, TokenDisplayMetadata>> = REPLICA_TOKEN_METADATA,
) {
  const known = baseMints.map((mint) => tokenMetadata(mint, genesisHash, replicas));
  const assets = new Set(
    known.flatMap((metadata) => (metadata ? [metadata.asset ?? metadata.symbol] : [])),
  );
  const shared = assets.size === 1 ? [...assets][0] : undefined;
  const ticker = shared ?? fallbackTicker;
  const devnetAsset = known.find(
    (metadata) => metadata?.devnet && (metadata.asset ?? metadata.symbol) === shared,
  );
  const assetMetadata: TokenDisplayMetadata | undefined = !shared
    ? undefined
    : (devnetAsset ??
      Object.freeze({
        symbol: shared,
        name: ASSET_NAMES[shared] ?? assetDisplayName(shared) ?? shared,
        image: assetImage(shared),
        devnet: false,
        asset: shared,
      }));
  const quote = tokenMetadata(quoteMint, genesisHash);
  const used = new Set<string>();
  const legs: LegDisplay[] = baseMints.map((_mint, index) => {
    const metadata = known[index];
    let symbol = metadata?.symbol ?? (baseMints.length === 1 ? ticker : `${ticker}·${index + 1}`);
    if (used.has(symbol)) symbol = `${symbol}·${index + 1}`;
    used.add(symbol);
    return {
      ...(metadata ? { metadata } : {}),
      symbol,
      issuer: metadata ? (metadata.issuer ?? issuerFromSymbol(metadata.symbol)) : null,
    };
  });
  return {
    ticker,
    assetKey: shared ? `asset:${shared}` : `mints:${[...baseMints].sort().join(",")}`,
    legs,
    ...(assetMetadata ? { assetMetadata } : {}),
    ...(quote ? { quoteTokenMetadata: quote } : {}),
  };
}
