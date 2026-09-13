// Temporary display-only aliases for the public mints in .local/devnet/plan.json.
// Never derive trading precision, issuer support, prices, or balances from this map.
import { DEVNET_ASSET_MINTS, SOLANA_DEVNET_GENESIS } from "@conditional-stocks/shared/spot-prices";
export { SOLANA_DEVNET_GENESIS };

export interface TokenDisplayMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly image: string;
  readonly devnet: true;
}

const token = (symbol: string, name: string): TokenDisplayMetadata =>
  Object.freeze({
    symbol,
    name,
    image: `/tokens/devnet/${symbol.toLowerCase()}.svg`,
    devnet: true,
  });

export const DEVNET_TOKEN_METADATA: Readonly<Record<string, TokenDisplayMetadata>> = Object.freeze({
  [DEVNET_ASSET_MINTS.USDC]: token("USDC", "USD Coin"),
  [DEVNET_ASSET_MINTS.BTC]: token("BTC", "Bitcoin"),
  [DEVNET_ASSET_MINTS.ETH]: token("ETH", "Ethereum"),
  [DEVNET_ASSET_MINTS.SOL]: token("SOL", "Wrapped SOL"),
  [DEVNET_ASSET_MINTS.TSLA]: token("TSLA", "Tesla"),
  [DEVNET_ASSET_MINTS.NVDA]: token("NVDA", "NVIDIA"),
  [DEVNET_ASSET_MINTS.SPY]: token("SPY", "SPDR S&P 500 ETF Trust"),
});

export function devnetTokenMetadata(mint: string, genesisHash: string) {
  // chainId=1 is a compatibility key shared by all Solana environments, not a network check.
  if (genesisHash !== SOLANA_DEVNET_GENESIS || !Object.hasOwn(DEVNET_TOKEN_METADATA, mint))
    return undefined;
  return DEVNET_TOKEN_METADATA[mint];
}

export function marketTokenDisplay(
  baseMint: string,
  quoteMint: string,
  genesisHash: string,
  fallbackTicker: string,
) {
  const base = devnetTokenMetadata(baseMint, genesisHash);
  const quote = devnetTokenMetadata(quoteMint, genesisHash);
  return {
    ticker: base?.symbol ?? fallbackTicker,
    ...(base ? { baseTokenMetadata: base } : {}),
    ...(quote ? { quoteTokenMetadata: quote } : {}),
  };
}
