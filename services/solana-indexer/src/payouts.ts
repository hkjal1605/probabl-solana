import { big, claimAsset, key, underlyingAsset, walletAddress } from "@conditional-stocks/solana-client";
import type { Snapshot } from "./projection";

export function payoutCredits(s: Snapshot, owner: string) {
  const payouts = [];
  for (const [id, credit] of s.credits) {
    if (String(credit.owner) !== owner || !big(credit.available)) continue;
    const pool = s.pools.get(String(credit.pool));
    if (!pool) throw new Error("Credit pool missing");
    payouts.push({
      id,
      scope: "global",
      pool: String(credit.pool),
      beneficiary: owner,
      asset: String(pool.mint),
      tokenId: "0",
      amount: String(credit.available),
      collateralToken: String(pool.mint),
      decimals: pool.decimals,
      branch: null,
      kind: pool.mint.equals(s.config.quote_mint) ? "quote" : "stock",
      collateral: null,
      marketId: null,
      confirmation: "finalized",
    });
  }
  for (const [id, market] of s.markets) {
    const wallet = s.wallets.get(String(walletAddress(key(id), key(owner), s.program)));
    if (!wallet) continue;
    for (let collateral = 0; collateral <= market.bases; collateral++)
      for (const branch of [0, 1]) {
        const asset = claimAsset(collateral, branch);
        const amount = big(wallet.balances[asset]!);
        if (!amount) continue;
        payouts.push({
          id: id + ":" + asset,
          scope: "market",
          pool: null,
          beneficiary: owner,
          asset: String(market.mints[asset]),
          tokenId: String(asset),
          amount: String(amount),
          collateralToken: String(market.mints[underlyingAsset(collateral)]),
          decimals: market.decimals[collateral],
          branch: branch === 0 ? "YES" : "NO",
          kind: collateral === 0 ? "quote" : "stock",
          /** 0 = quote, 1.. = issuer leg. */
          collateral,
          marketId: id,
          confirmation: "finalized",
        });
      }
  }
  return payouts;
}
