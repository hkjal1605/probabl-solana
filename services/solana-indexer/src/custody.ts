import {
  ASSETS,
  COLLATERALS,
  big,
  key,
  poolAddress,
  assetCreditAddress,
  walletAddress,
  fundingAsset,
  isClaimAsset,
  orderCollateral,
  orderWire,
  underlyingAsset,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "./projection";

/** Available underlying is owned once per (deployment, mint, owner), never per market. */
export function globalAvailable(s: Snapshot, owner: string, mint: string): bigint {
  const pool = [...s.pools].find(([, p]) => p.mint.toBase58() === mint);
  if (!pool) return 0n;
  return big(
    s.credits.get(assetCreditAddress(key(pool[0]), key(owner), s.program).toBase58())?.available ??
      0,
  );
}

/** Reservations stay locked even when an order expires or its key is revoked.
 * Only an on-chain cancellation/fill releases them. Never use liveOrder here.
 * A pool-funded bid reserves the quote; a pool-funded ask reserves raw units of
 * its own issuer leg (at the placement-time multiplier, rounded up). */
export function reservedUnderlying(s: Snapshot, owner: string, mint: string): bigint {
  let total = 0n;
  for (const order of s.orders.values()) {
    if (order.status !== 1 || order.terms.funding !== 0 || order.owner.toBase58() !== owner)
      continue;
    const market = s.markets.get(order.market.toBase58());
    if (!market) throw new Error("Reservation has no market");
    const collateral = orderCollateral({ side: order.terms.side, bases: order.terms.bases });
    if (market.mints[underlyingAsset(collateral)]!.toBase58() === mint)
      total += big(order.reserved);
  }
  return total;
}

const ledger = () => Array<bigint>(ASSETS).fill(0n);

/** Exact ledger proof from ONE getProgramAccounts bank image. External custody
 * is audited separately with each pool/market and its token accounts in one bank. */
export function reconcileLedger(s: Snapshot) {
  const allocated = new Map<string, bigint>([...s.pools.keys()].map((id) => [id, 0n]));
  const add = (pool: string, amount: bigint) => {
    if (!allocated.has(pool)) throw new Error("Missing initialized underlying pool");
    allocated.set(pool, allocated.get(pool)! + amount);
  };
  for (const credit of s.credits.values()) add(credit.pool.toBase58(), big(credit.available));
  const walletTotals = new Map<string, bigint[]>();
  const escrowTotals = new Map<string, bigint[]>();
  for (const [id, market] of s.markets) {
    if (
      market.mints.length !== ASSETS ||
      market.credits.length !== ASSETS ||
      market.escrow.length !== ASSETS ||
      market.fees.length !== ASSETS
    )
      throw new Error("Malformed market ledgers");
    walletTotals.set(id, ledger());
    escrowTotals.set(id, ledger());
  }
  for (const wallet of s.wallets.values()) {
    const totals = walletTotals.get(wallet.market.toBase58());
    if (!totals) throw new Error("Orphan market wallet");
    for (let a = 0; a < ASSETS; a++) {
      const amount = big(wallet.balances[a]!);
      if (!isClaimAsset(a)) {
        if (amount) throw new Error("Market wallet contains global underlying credit");
        continue;
      }
      totals[a]! += amount;
    }
  }
  for (const order of s.orders.values()) {
    if (order.status !== 1) {
      if (big(order.reserved)) throw new Error("Closed order retains reservation");
      continue;
    }
    if (!s.wallets.has(walletAddress(order.market, order.owner, s.program).toBase58()))
      throw new Error("Reservation owner has no market wallet");
    const totals = escrowTotals.get(order.market.toBase58());
    if (!totals) throw new Error("Orphan reservation");
    totals[fundingAsset(orderWire(order))]! += big(order.reserved);
  }
  for (const [id, market] of s.markets) {
    for (let a = 0; a < ASSETS; a++) {
      if (!isClaimAsset(a) && big(market.credits[a]!))
        throw new Error("Market contains global underlying credit");
      if (walletTotals.get(id)![a] !== big(market.credits[a]!))
        throw new Error("Market claim credit ledger mismatch");
      if (escrowTotals.get(id)![a] !== big(market.escrow[a]!))
        throw new Error("Market reservation ledger mismatch");
    }
    // Each listed collateral's backing and pool-funded reservations are a
    // liability of that collateral's protocol-wide pool.
    for (let c = 0; c < COLLATERALS; c++) {
      const asset = underlyingAsset(c);
      const liability = big(market.backing[c]!) + big(market.escrow[asset]!);
      if (market.vaults_initialized & (1 << asset)) {
        if (c > market.bases) throw new Error("Unlisted collateral is initialized");
        add(poolAddress(market.config, market.mints[asset]!, s.program).toBase58(), liability);
      } else if (liability) throw new Error("Uninitialized collateral has liabilities");
    }
  }
  for (const [id, pool] of s.pools)
    if (allocated.get(id) !== big(pool.liability))
      throw new Error(`Global pool liability mismatch: ${id}`);
  return { pools: s.pools.size, credits: s.credits.size, markets: s.markets.size, slot: s.slot };
}
