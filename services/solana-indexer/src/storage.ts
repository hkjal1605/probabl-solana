import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import { SNAPSHOT_VERSION } from "@conditional-stocks/db/solana";
import { claimAsset } from "@conditional-stocks/solana-client";
import { indexedOrder, marketView, type Snapshot } from "./projection";
import { reconcileLedger } from "./custody";

/** Projection is service-owned; SQL, atomic publication and schema are DB-owned. */
export async function persistSnapshot(
  db: SolanaDatabase,
  domain: string,
  s: Snapshot,
  retiredOrders: unknown,
) {
  reconcileLedger(s);
  return db.persistSnapshot(domain, {
    slot: s.slot,
    observedAt: s.observedAt,
    pools: [...s.pools].map(([address, p]) => ({
      address,
      mint: String(p.mint),
      token_program: String(p.token_program),
      decimals: p.decimals,
      liability: String(p.liability),
    })),
    credits: [...s.credits].map(([address, c]) => ({
      address,
      pool: String(c.pool),
      owner: String(c.owner),
      available: String(c.available),
    })),
    // Claim credit of every listed collateral (quote and each issuer leg).
    claims: [...s.wallets.values()].flatMap((w) => {
      const market = s.markets.get(String(w.market))!;
      return Array.from({ length: market.bases + 1 }, (_, c) =>
        [0, 1].map((branch) => claimAsset(c, branch)),
      )
        .flat()
        .map((asset) => ({
          market: String(w.market),
          owner: String(w.owner),
          mint: String(market.mints[asset]),
          asset,
          available: String(w.balances[asset]),
        }));
    }),
    accounts: {
      version: SNAPSHOT_VERSION,
      healthy: true,
      rawAccounts: s.rawAccounts,
      retiredOrders,
      markets: [...s.markets].map(([id, m]) =>
        marketView(id, m, s.createdAt?.get(id), s.legs?.get(id)),
      ),
      orders: [...s.orders].map(([id, o]) => indexedOrder(id, o, s.slot)),
    },
  });
}
