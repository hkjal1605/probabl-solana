import { Keypair, PublicKey } from "@solana/web3.js";
import {
  bn,
  WAD,
  type MarketAccount,
  type ConfigAccount,
  type OrderAccount,
} from "@conditional-stocks/solana-client";
import {
  DEVNET_ASSET_MINTS,
  SOLANA_DEVNET_GENESIS,
  SOLANA_MAINNET_GENESIS,
  spotMapping,
} from "@conditional-stocks/shared/spot-prices";
import { key } from "@conditional-stocks/solana-client";
import type { Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { settings, type MarketPolicy } from "../src/config";
export const owner = Keypair.generate().publicKey,
  id = Keypair.generate().publicKey.toBase58();
export const policy: MarketPolicy = {
  market: id,
  baseMint: DEVNET_ASSET_MINTS.BTC,
  quoteMint: DEVNET_ASSET_MINTS.USDC,
  baseInventory: "1",
  quoteInventory: "100",
  orderQuote: "5",
  gapBps: 2000,
  basePriceMultiplier: "1",
  quotePriceMultiplier: "1",
};
export const config = settings({ markets: [policy] });
export const market = {
  config: key(id),
  id: Array(32).fill(1),
  state: 2,
  vaults_initialized: 63,
  mints: [
    key(policy.baseMint),
    key(policy.quoteMint),
    ...Array.from({ length: 4 }, () => Keypair.generate().publicKey),
  ],
  decimals: [8, 6],
  sequence: [bn(0), bn(0)],
  open_notional: bn(0),
  terms: {
    condition: Array(32).fill(1),
    yes_index: 1,
    no_index: 2,
    trading_open: bn(1),
    trading_cutoff: bn(4_000_000_000),
    tick: bn(10n ** 14n),
    step: bn(10_000n),
    min_notional: bn(1),
    max_quantity: bn(10n ** 12n),
    max_order: bn(10n ** 12n),
    max_wallet: bn(10n ** 12n),
    max_market: bn(10n ** 12n),
  },
} as MarketAccount;
export const reference = {
  spot: WAD,
  probability: 400000n,
  observedAt: Date.now(),
  spread: 20000n,
};
export function book(): Snapshot {
  return {
    program: key(id),
    slot: 100,
    observedAt: Date.now(),
    config: {
      maker_bps: 10,
      taker_bps: 20,
      paused: false,
      quote_mint: key(policy.quoteMint),
    } as ConfigAccount,
    markets: new Map([[id, market]]),
    orders: new Map(),
    wallets: new Map(),
    traders: new Map(),
    pools: new Map(),
    credits: new Map(),
  };
}
export function order(branch = 0, side = 0): OrderAccount {
  return {
    delegate: PublicKey.default,
    market: key(id),
    owner,
    terms: {
      recipient: owner,
      salt: Array(32).fill(7),
      branch,
      side,
      funding: 1,
      tif: 0,
      price: bn(WAD),
      quantity: bn(1000000),
      expiry: bn(4_000_000_000),
      nonce: bn(0),
      max_fee_bps: 10,
    },
    status: 1,
    reserved: bn(1000000),
    remaining: bn(1000000),
    open_notional: bn(1000000),
  } as OrderAccount;
}
export function feeds(now = Date.now()) {
  const source = {
    metadata: {
      normalized: {
        conditionId: "0x" + "01".repeat(32),
        active: true,
        closed: false,
        outcomes: [
          { label: "YES", tokenId: "123", indexSet: "1" },
          { label: "NO", tokenId: "456", indexSet: "2" },
        ],
      },
    },
    probability: {
      conditionId: "0x" + "01".repeat(32),
      yesTokenId: "123",
      schemaVersion: 1,
      quality: "valid",
      isStale: false,
      observedAtMs: String(now),
      midpointX6: "400000",
      bestBidX6: "390000",
      bestAskX6: "410000",
      spreadX6: "20000",
      standardNotionalX6: "1000000",
      bidDepthQuoteX6: "1000000",
      askDepthQuoteX6: "1000000",
    },
  };
  const prices = {
    source: "jupiter",
    sourceGenesisHash: SOLANA_MAINNET_GENESIS,
    genesisHash: SOLANA_DEVNET_GENESIS,
    displayOnly: true,
    asOf: Math.floor(now / 1000),
    prices: [policy.baseMint, policy.quoteMint].map((mint, i) => ({
      ...spotMapping(SOLANA_DEVNET_GENESIS, mint),
      status: "available",
      priceUsd: i === 0 ? 100 : 1,
      blockId: 100,
      sourceDecimals: i === 0 ? 8 : 6,
      priceTimestamp: Math.floor(now / 1000),
      fetchedAt: Math.floor(now / 1000),
    })),
  };
  return { source, prices, now };
}
