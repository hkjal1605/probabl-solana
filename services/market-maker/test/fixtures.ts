import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ASSETS,
  COLLATERALS,
  MAX_BASES,
  UNIT_MULTIPLIER,
  WAD,
  assetCreditAddress,
  bn,
  claimAddress,
  isClaimAsset,
  key,
  multiplierValue,
  poolAddress,
  underlyingAsset,
  type ConfigAccount,
  type LiveLeg,
  type MarketAccount,
  type OrderAccount,
  emptyRecent,
} from "@conditional-stocks/solana-client";
import {
  MAINNET_REFERENCE_MINTS,
  SOLANA_MAINNET_GENESIS,
  spotMapping,
} from "@conditional-stocks/shared/spot-prices";
import type { Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { referenceMints, settings, type MarketPolicy } from "../src/config";

/** Mainnet NVDA issuer tokens: xStocks (8 decimals), Ondo and Remora (9 decimals). */
export const NVDA = {
  x: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  on: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
  r: "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu",
};
export const USDC = MAINNET_REFERENCE_MINTS.USDC;
export const owner = Keypair.generate().publicKey,
  id = Keypair.generate().publicKey.toBase58(),
  deployment = Keypair.generate().publicKey;
export const policy: MarketPolicy = {
  market: id,
  baseMints: [NVDA.x, NVDA.on, NVDA.r],
  quoteMint: USDC,
  baseInventories: ["1", "1", "1"],
  quoteInventory: "1000",
  orderQuote: "25",
  gapBps: 2000,
  basePriceMultipliers: ["1", "1", "1"],
  quotePriceMultiplier: "1",
};
export const config = settings({ markets: [policy] });
/** 1 share = 10^6 share units; leg scales 100 (8 decimals) and 1000 (9 decimals). */
export const scales = [100n, 1000n, 1000n];

/** A multi-issuer market image: quote plus `legs` issuer legs, all initialized. */
export function marketAccount(
  input: {
    market?: PublicKey;
    config?: PublicKey;
    quoteMint?: string;
    baseMints?: string[];
    decimals?: number[];
    scales?: bigint[];
    multipliers?: bigint[];
  } = {},
): MarketAccount {
  const address = input.market ?? key(id),
    baseMints = input.baseMints ?? policy.baseMints,
    legs = baseMints.length;
  const mints = Array.from({ length: ASSETS }, () => PublicKey.default);
  mints[0] = key(input.quoteMint ?? policy.quoteMint);
  for (let c = 1; c <= legs; c++) mints[underlyingAsset(c)] = key(baseMints[c - 1]!);
  let initialized = 0;
  for (let asset = 0; asset < 3 * (1 + legs); asset++) {
    initialized |= 1 << asset;
    if (isClaimAsset(asset)) mints[asset] = claimAddress(address, asset);
  }
  const decimals = input.decimals ?? [6, 8, 9, 9];
  return {
    config: input.config ?? deployment,
    id: Array(32).fill(1),
    bases: legs,
    legs: Array.from({ length: MAX_BASES }, (_, i) => ({
      scale: bn(i < legs ? (input.scales ?? scales)[i]! : 0n),
      multiplier: bn(i < legs ? (input.multipliers?.[i] ?? UNIT_MULTIPLIER) : 0n),
      active: i < legs,
    })),
    mints,
    decimals: Array.from({ length: COLLATERALS }, (_, c) => decimals[c] ?? 0),
    pool_bumps: Array(COLLATERALS).fill(255),
    vaults_initialized: initialized,
    state: 2,
    sequence: [bn(0), bn(0)],
    recent: emptyRecent(),
    open_notional: bn(0),
    credits: Array.from({ length: ASSETS }, () => bn(0)),
    escrow: Array.from({ length: ASSETS }, () => bn(0)),
    backing: Array.from({ length: COLLATERALS }, () => bn(0)),
    fees: Array.from({ length: ASSETS }, () => bn(0)),
    resolution_commitment: Array(32).fill(0),
    payouts: [0, 0],
    evidence: Array(32).fill(0),
    evidence_uri: "",
    resolved_at: bn(0),
    bump: 0,
    terms: {
      condition: Array(32).fill(1),
      yes_index: 1,
      no_index: 2,
      rules_hash: Array(32).fill(0),
      metadata_hash: Array(32).fill(0),
      metadata_uri: "",
      trading_open: bn(1),
      trading_cutoff: bn(4_000_000_000),
      share_decimals: 6,
      // Quote raw per share unit x 1e18: one cent per share.
      tick: bn(10n ** 16n),
      step: bn(10_000n),
      min_notional: bn(1),
      max_quantity: bn(10n ** 12n),
      max_order: bn(10n ** 12n),
      max_wallet: bn(10n ** 12n),
      max_market: bn(10n ** 12n),
    },
  };
}
export const market = marketAccount();

/** Live leg state as the SDK's `liveLegs` reports it; every leg tradable by default. */
export function legs(
  patch: Partial<Record<number, Partial<LiveLeg>>> = {},
  m: MarketAccount = market,
): Record<number, LiveLeg> {
  const result: Record<number, LiveLeg> = {};
  for (let c = 1; c <= m.bases; c++) {
    const listing = BigInt(m.legs[c - 1]!.multiplier.toString()),
      leg: LiveLeg = {
        collateral: c,
        mint: m.mints[underlyingAsset(c)]!.toBase58(),
        decimals: m.decimals[c]!,
        scale: BigInt(m.legs[c - 1]!.scale.toString()),
        multiplier: listing,
        listingMultiplier: listing,
        multiplierValue: multiplierValue(listing),
        tradable: true,
        active: true,
        ready: true,
        paused: false,
        vaultFrozen: false,
        halt: null,
        issuer: null,
        ...patch[c],
      };
    leg.multiplierValue = multiplierValue(leg.multiplier);
    result[c] = leg;
  }
  return result;
}
/** Halt a leg the way `liveLegs` reports an issuer pause. */
export const paused = { tradable: false, paused: true, halt: "issuer-paused" as const };

/** $100 per share: 100 quote raw per share unit. */
export const reference = {
  spot: 100n * WAD,
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
/** Raw balances by asset: quote claims, then per-leg YES/NO claims. */
export function balances(quoteClaims: bigint, legClaims: bigint[] = []): bigint[] {
  const result = Array<bigint>(ASSETS).fill(0n);
  result[1] = result[2] = quoteClaims;
  for (const [i, raw] of legClaims.entries()) result[3 * (i + 1) + 1] = result[3 * (i + 1) + 2] = raw;
  return result;
}
/** Seeded inventory: 1000 USDC per branch and one share of every issuer. */
export const seeded = () => balances(1_000_000_000n, [100_000_000n, 1_000_000_000n, 1_000_000_000n]);
export function order(branch = 0, side = 0, bases = side === 0 ? 7 : 1): OrderAccount {
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
      price: bn(100n * WAD),
      quantity: bn(1000000),
      expiry: bn(4_000_000_000),
      nonce: bn(0),
      max_fee_bps: 10,
      bases,
    },
    status: 1,
    reserved: bn(1000000),
    remaining: bn(1000000),
    open_notional: bn(1000000),
  } as OrderAccount;
}
/** Protocol-wide pools and one owner's unreserved credit per mint. */
export function custody(s: Snapshot, holder: PublicKey, available: Record<string, bigint>) {
  for (const [mint, amount] of Object.entries(available)) {
    const pool = poolAddress(deployment, key(mint), s.program);
    s.pools.set(String(pool), {
      config: deployment,
      mint: key(mint),
      token_program: TOKEN_PROGRAM_ID,
      decimals: 6,
      liability: bn(amount),
      bump: 0,
      admitted: 0,
      vault_bump: 0,
    });
    s.credits.set(String(assetCreditAddress(pool, holder, s.program)), {
      pool,
      owner: holder,
      available: bn(amount),
      bump: 0,
    });
  }
}
export function feeds(now = Date.now(), p: MarketPolicy = policy, genesis = SOLANA_MAINNET_GENESIS) {
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
  const mints = [...referenceMints(p), p.quoteMint];
  const prices = {
    source: "jupiter",
    sourceGenesisHash: SOLANA_MAINNET_GENESIS,
    genesisHash: genesis,
    displayOnly: true,
    asOf: Math.floor(now / 1000),
    prices: mints.map((mint, i) => ({
      ...spotMapping(genesis, mint),
      status: "available",
      priceUsd: i === mints.length - 1 ? 1 : 100,
      blockId: 100,
      sourceDecimals: 6,
      priceTimestamp: Math.floor(now / 1000),
      fetchedAt: Math.floor(now / 1000),
    })),
  };
  return { source, prices, now };
}
