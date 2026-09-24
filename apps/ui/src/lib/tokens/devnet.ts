// Temporary display-only aliases for the public mints in .local/devnet/plan.json,
// plus the issuer-published mainnet stock tokens a multi-issuer market can list.
// Never derive trading precision, issuer support, prices, or balances from this map.
import { DEVNET_ASSET_MINTS, SOLANA_DEVNET_GENESIS } from "@conditional-stocks/shared/spot-prices";

export { SOLANA_DEVNET_GENESIS };

export interface TokenDisplayMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly image: string;
  /** Devnet test asset (as opposed to a real issuer token). */
  readonly devnet: boolean;
  /** Underlying asset ticker shared by every issuer token of one stock (e.g. NVDA). */
  readonly asset?: string;
  /** Token issuer (e.g. xStocks, Ondo Global Markets, Remora). */
  readonly issuer?: string;
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

/** Issuer-published mainnet stock tokens (docs/multi-issuer-markets.md). Keyed by exact mint. */
export const ISSUER_TOKEN_METADATA: Readonly<Record<string, TokenDisplayMetadata>> = Object.freeze({
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: issuerToken(
    "NVDAx",
    "NVIDIA xStock",
    "NVDA",
    TOKEN_ISSUERS.xStocks,
  ),
  gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo: issuerToken(
    "NVDAon",
    "NVIDIA (Ondo Tokenized)",
    "NVDA",
    TOKEN_ISSUERS.ondo,
  ),
  ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu: issuerToken(
    "NVDAr",
    "NVIDIA (Remora)",
    "NVDA",
    TOKEN_ISSUERS.remora,
  ),
});

export function devnetTokenMetadata(mint: string, genesisHash: string) {
  // chainId=1 is a compatibility key shared by all Solana environments, not a network check.
  if (genesisHash !== SOLANA_DEVNET_GENESIS || !Object.hasOwn(DEVNET_TOKEN_METADATA, mint))
    return undefined;
  return DEVNET_TOKEN_METADATA[mint];
}

/** Display metadata of an issuer or devnet token. Issuer mints are unique addresses on any cluster. */
export function tokenMetadata(mint: string, genesisHash: string): TokenDisplayMetadata | undefined {
  if (Object.hasOwn(ISSUER_TOKEN_METADATA, mint)) return ISSUER_TOKEN_METADATA[mint];
  return devnetTokenMetadata(mint, genesisHash);
}

/** Display issuer inferred from a token symbol suffix (NVDAx, NVDAon, NVDAr). Display only. */
export function issuerFromSymbol(symbol: string): string | null {
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
) {
  const known = baseMints.map((mint) => tokenMetadata(mint, genesisHash));
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
        name: ASSET_NAMES[shared] ?? shared,
        image: `/tokens/devnet/${shared.toLowerCase()}.svg`,
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
