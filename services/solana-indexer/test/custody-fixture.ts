import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ASSETS,
  COLLATERALS,
  MAX_BASES,
  PublicKey,
  PROGRAM_ID,
  UNIT_MULTIPLIER,
  bn,
  poolAddress,
  assetCreditAddress,
  walletAddress,
  marketAddress,
  claimAddress,
  configAddress,
  digest,
  isClaimAsset,
  underlyingAsset,
  type MarketAccount,
  emptyRecent,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "../src/projection";

/** A multi-issuer market image: quote (collateral 0) plus one listed leg per
 * base mint, every listed collateral fully initialized. */
export function marketFixture(input: {
  config: PublicKey;
  market: PublicKey;
  program?: PublicKey;
  quote: PublicKey;
  bases: PublicKey[];
  id?: Uint8Array;
  decimals?: number[];
  scales?: bigint[];
  multipliers?: bigint[];
  shareDecimals?: number;
  state?: number;
}): MarketAccount {
  const program = input.program ?? PROGRAM_ID,
    legs = input.bases.length;
  if (legs < 1 || legs > MAX_BASES) throw new Error("fixture legs");
  const mints = Array.from({ length: ASSETS }, () => PublicKey.default);
  mints[0] = input.quote;
  input.bases.forEach((mint, i) => {
    mints[underlyingAsset(i + 1)] = mint;
  });
  let initialized = 0;
  for (let asset = 0; asset < 3 * (legs + 1); asset++) {
    initialized |= 1 << asset;
    if (isClaimAsset(asset)) mints[asset] = claimAddress(input.market, asset, program);
  }
  const decimals = input.decimals ?? Array(legs + 1).fill(6);
  return {
    config: input.config,
    id: [...(input.id ?? new Uint8Array(32))],
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
    resolution_commitment: Array(32).fill(0),
    payouts: [0, 0],
    evidence: Array(32).fill(0),
    evidence_uri: "",
    resolved_at: bn(0),
    bump: 0,
    terms: {
      condition: [...digest("same-event")],
      yes_index: 1,
      no_index: 2,
      rules_hash: Array(32).fill(1),
      metadata_hash: Array(32).fill(1),
      metadata_uri: "ipfs://test",
      trading_open: bn(0),
      trading_cutoff: bn(9999999999),
      share_decimals: input.shareDecimals ?? 6,
      tick: bn(1),
      step: bn(1),
      min_notional: bn(1),
      max_quantity: bn(1000),
      max_order: bn(1000),
      max_wallet: bn(10000),
      max_market: bn(10000),
    },
  };
}

/** Two sibling markets sharing protocol-wide pools: quote plus `legs` issuer
 * legs. Each market backs 50 quote and 40 of every leg; the owner holds 20/30
 * leg-1 YES credit in the two markets. */
export function custodyFixture(legs = 1) {
  const owner = PublicKey.unique(),
    other = PublicKey.unique(),
    bases = Array.from({ length: legs }, () => PublicKey.unique()),
    base = bases[0]!,
    quote = PublicKey.unique();
  const config = configAddress(owner),
    program = PROGRAM_ID;
  const s: Snapshot = {
    program,
    slot: 100,
    observedAt: Date.now(),
    config: {
      seed_authority: owner,
      admin: owner,
      quote_mint: quote,
      roles: { market_admin: owner, guardian: owner, resolution_admin: owner },
      paused: false,
      maker_bps: 0,
      taker_bps: 0,
      pending_admin: PublicKey.default,
      admin_after: bn(0),
      bump: 0,
    },
    pools: new Map(),
    credits: new Map(),
    markets: new Map(),
    orders: new Map(),
    wallets: new Map(),
    traders: new Map(),
    delegations: new Map(),
  };
  for (const [mint, available, backing] of [
    ...bases.map((mint) => [mint, 100, 80] as const),
    [quote, 200, 100] as const,
  ]) {
    const p = poolAddress(config, mint, program);
    s.pools.set(String(p), {
      config,
      mint,
      token_program: TOKEN_PROGRAM_ID,
      decimals: 6,
      liability: bn(available + backing),
      bump: 0,
      admitted: 0,
      vault_bump: 0,
    });
    s.credits.set(String(assetCreditAddress(p, owner, program)), {
      pool: p,
      owner,
      available: bn(available),
      bump: 0,
    });
  }
  for (let i = 0; i < 2; i++) {
    const id = digest("global-custody-test:" + i),
      m = marketAddress(config, id, program);
    const market = marketFixture({ config, market: m, program, quote, bases, id });
    market.backing = [bn(50), ...bases.map(() => bn(40)), ...Array(MAX_BASES - legs).fill(bn(0))];
    market.credits[4] = bn(20 + i * 10);
    s.markets.set(String(m), market);
    s.wallets.set(String(walletAddress(m, owner, program)), {
      market: m,
      owner,
      balances: [...market.credits],
      open_notional: bn(0),
      bump: 0,
    });
  }
  return { s, owner, other, base, bases, quote, config };
}
