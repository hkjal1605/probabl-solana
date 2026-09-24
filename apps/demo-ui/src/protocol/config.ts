import { SOLANA_DEVNET_GENESIS } from "@conditional-stocks/shared/spot-prices";
import { base58Id } from "./random";

export const PROGRAM_ID = "8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg";
export const CONFIG_ACCOUNT = "6buYkVtSJjaoozCDsPFYrPhp5g1q1oLg2eLp7FpsZ1tF";
export const GENESIS_HASH = SOLANA_DEVNET_GENESIS;
export const CLUSTER_NAME = "Solana Devnet";

export const QUOTE_MINT = "iTUCuHTUHKqWe3XhUc5J3dSjmDdNuQKYtQh8KDYZdDD";

/** The wallet address a connection resolves to, and the key that signs orders for it. */
export const ACCOUNT_ADDRESS = "7rQm4kVsXhPqY2tGuLn8ZwDcEeF3aBjRvNsKdTuW9xHz";
export const TRADING_DELEGATE = "Dg8pTnQvXbLmYc3WhFuRjKe5ZaS2NpVdHt7BqMxGw4Ru";

/** Starting wallet holdings, in whole display units. */
export const STARTING_WALLET_BALANCES: Readonly<Record<string, number>> = {
  [QUOTE_MINT]: 25_000,
  "8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3": 60, // SPY
  "8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u": 180, // NVDA
  DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC: 120, // TSLA
};

/** USD reference prices the spot feed walks away from. */
export const SPOT_ANCHORS: Readonly<Record<string, number>> = {
  [QUOTE_MINT]: 0.9999,
  "8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3": 773.2,
  "8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u": 227.37,
  DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC: 374.36,
};

export const SPOT_SOURCE_MINTS: Readonly<Record<string, string>> = {
  [QUOTE_MINT]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3": "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  "8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u": "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
};

export const SPOT_REFERENCE_SYMBOLS: Readonly<Record<string, string>> = {
  [QUOTE_MINT]: "USDC",
  "8gASFJiYjt7LCt9Ycs3DzhEWjVSsy44AzVaT33fjPmq3": "SPYx",
  "8GmgkFJYZShkt9ixssZmSQb4GPc7JcPK2EQKqAQCgb6u": "NVDAx",
  DdVCyyE4uWbG69K1SCXhauM9hRoMZrs7xG81DUCqebTC: "TSLAx",
};

/** Events whose lifecycle advances past `open`, so settlement and redemption are reachable. */
export const LIFECYCLE_OVERRIDES: Readonly<Record<string, number>> = {
  // "Will Cintas (CTAS) beat quarterly earnings?" — settled YES, claims redeemable.
  "0x43deba5d45a469c11be88dbf6769ce958d107f2b7f5dfe73403603e00b4aac1c": 6,
  // "Will Costco (COST) beat quarterly earnings?" — books closed, evidence in review.
  "0x4055d3b5a26df2632f0616402b602b20ef60816e7f17d6174dcf272aa45db4c2": 4,
};

/** Claim mints are derived from the market and asset index, mirroring onchain claim accounts. */
export function claimMintAddress(marketId: string, asset: number): string {
  return base58Id(`claim:${marketId}:${asset}`, 44);
}

/** 0 base / 1 quote whole tokens; 2-3 stock claims; 4-5 quote claims. */
export const CLAIM_ASSET = {
  stockYes: 2,
  stockNo: 3,
  quoteYes: 4,
  quoteNo: 5,
} as const;

export const TICK_INTERVAL_MS = 1200;
export const MAX_TRADES_PER_MARKET = 400;
