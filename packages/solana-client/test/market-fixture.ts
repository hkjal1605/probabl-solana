import { PublicKey } from "@solana/web3.js";
import {
  ASSETS,
  COLLATERALS,
  MAX_BASES,
  UNIT_MULTIPLIER,
  bn,
  claimAddress,
  isClaimAsset,
  underlyingAsset,
  type MarketAccount,
  emptyRecent,
} from "../src/index";

/** A fully initialized market image in the multi-issuer layout: quote plus
 * `legs` base legs (1..=MAX_BASES), each with its own underlying mint. */
export function marketAccount(input: {
  config: PublicKey;
  market: PublicKey;
  program?: PublicKey;
  legs?: number;
  quoteMint?: PublicKey;
  baseMints?: PublicKey[];
  decimals?: number[];
  scales?: bigint[];
  multipliers?: bigint[];
  shareDecimals?: number;
  state?: number;
}): MarketAccount {
  const legs = input.legs ?? 1;
  if (legs < 1 || legs > MAX_BASES) throw new Error("fixture legs");
  const zeros = () => Array(32).fill(0);
  const mints = Array.from({ length: ASSETS }, () => PublicKey.default);
  mints[0] = input.quoteMint ?? PublicKey.unique();
  for (let c = 1; c <= legs; c++) mints[underlyingAsset(c)] = input.baseMints?.[c - 1] ?? PublicKey.unique();
  let initialized = 0;
  for (let asset = 0; asset < 3 * (1 + legs); asset++) {
    initialized |= 1 << asset;
    if (isClaimAsset(asset)) mints[asset] = claimAddress(input.market, asset, input.program);
  }
  const decimals = input.decimals ?? [6, ...Array(legs).fill(6)];
  return {
    config: input.config,
    id: zeros(),
    bases: legs,
    legs: Array.from({ length: MAX_BASES }, (_, i) => ({
      scale: bn(i < legs ? (input.scales?.[i] ?? 1n) : 0n),
      multiplier: bn(i < legs ? (input.multipliers?.[i] ?? UNIT_MULTIPLIER) : 0n),
      active: i < legs,
    })),
    mints,
    decimals: Array.from({ length: COLLATERALS }, (_, c) => decimals[c] ?? 0),
    pool_bumps: Array(COLLATERALS).fill(255),
    vaults_initialized: initialized,
    state: input.state ?? 2,
    sequence: [bn(0), bn(0)],
    recent: emptyRecent(),
    open_notional: bn(0),
    credits: Array.from({ length: ASSETS }, () => bn(0)),
    escrow: Array.from({ length: ASSETS }, () => bn(0)),
    backing: Array.from({ length: COLLATERALS }, () => bn(0)),
    fees: Array.from({ length: ASSETS }, () => bn(0)),
    resolution_commitment: zeros(),
    payouts: [0, 0],
    evidence: zeros(),
    evidence_uri: "",
    resolved_at: bn(0),
    bump: 0,
    terms: {
      condition: zeros(),
      yes_index: 1,
      no_index: 2,
      rules_hash: zeros(),
      metadata_hash: zeros(),
      metadata_uri: "",
      trading_open: bn(0),
      trading_cutoff: bn(4_000_000_000),
      share_decimals: input.shareDecimals ?? 6,
      tick: bn(1),
      step: bn(1),
      min_notional: bn(1),
      max_quantity: bn(1_000_000),
      max_order: bn(1_000_000),
      max_wallet: bn(1_000_000),
      max_market: bn(1_000_000),
    },
  };
}
