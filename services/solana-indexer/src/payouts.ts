import { big, key, walletAddress } from "@conditional-stocks/solana-client";
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
      marketId: null,
      confirmation: "finalized",
    });
  }
  for (const [id, market] of s.markets) {
    const wallet = s.wallets.get(String(walletAddress(key(id), key(owner), s.program)));
    if (!wallet) continue;
    for (let asset = 2; asset < 6; asset++) {
      const amount = big(wallet.balances[asset]!);
      if (!amount) continue;
      const collateral = Math.floor((asset - 2) / 2);
      payouts.push({
        id: id + ":" + asset,
        scope: "market",
        pool: null,
        beneficiary: owner,
        asset: String(market.mints[asset]),
        tokenId: String(asset),
        amount: String(amount),
        collateralToken: String(market.mints[collateral]),
        decimals: market.decimals[collateral],
        branch: asset % 2 === 0 ? "YES" : "NO",
        kind: collateral === 0 ? "stock" : "quote",
        marketId: id,
        confirmation: "finalized",
      });
    }
  }
  return payouts;
}
