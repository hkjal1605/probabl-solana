import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  PROGRAM_ID,
  bn,
  poolAddress,
  assetCreditAddress,
  walletAddress,
  marketAddress,
  claimAddress,
  configAddress,
  digest,
  type MarketAccount,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "../src/projection";

export function custodyFixture() {
  const owner = PublicKey.unique(),
    other = PublicKey.unique(),
    base = PublicKey.unique(),
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
    [base, 100, 80],
    [quote, 200, 100],
  ] as const) {
    const p = poolAddress(config, mint, program);
    s.pools.set(String(p), {
      config,
      mint,
      token_program: TOKEN_PROGRAM_ID,
      decimals: 6,
      liability: bn(available + backing),
      bump: 0,
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
    const market: MarketAccount = {
      config,
      id: [...id],
      mints: [base, quote, ...[2, 3, 4, 5].map((a) => claimAddress(m, a, program))],
      decimals: [6, 6],
      terms: {
        condition: [...digest("same-event")],
        yes_index: 1,
        no_index: 2,
        rules_hash: Array(32).fill(1),
        metadata_hash: Array(32).fill(1),
        metadata_uri: "ipfs://test",
        trading_open: bn(0),
        trading_cutoff: bn(9999999999),
        tick: bn(1),
        step: bn(1),
        min_notional: bn(1),
        max_quantity: bn(1000),
        max_order: bn(1000),
        max_wallet: bn(10000),
        max_market: bn(10000),
      },
      vaults_initialized: 63,
      state: 2,
      sequence: [bn(0), bn(0)],
      open_notional: bn(0),
      credits: [0, 0, 20 + i * 10, 0, 0, 0].map(bn),
      escrow: Array(6).fill(bn(0)),
      backing: [bn(40), bn(50)],
      fees: Array(4).fill(bn(0)),
      resolution_commitment: Array(32).fill(0),
      payouts: [0, 0],
      evidence: Array(32).fill(0),
      evidence_uri: "",
      resolved_at: bn(0),
      bump: 0,
    };
    s.markets.set(String(m), market);
    s.wallets.set(String(walletAddress(m, owner, program)), {
      market: m,
      owner,
      balances: [...market.credits],
      open_notional: bn(0),
      bump: 0,
    });
  }
  return { s, owner, other, base, quote, config };
}
