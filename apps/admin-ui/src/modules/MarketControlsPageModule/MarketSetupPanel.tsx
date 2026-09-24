"use client";

import { key, SolanaClient } from "@conditional-stocks/solana-client";
import { useQuery } from "@tanstack/react-query";
import { QueryStatus } from "@/components/data/QueryStatus";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Badge } from "@/components/ui/badge";
import { adminConfig } from "@/config/protocol";
import { short } from "@/lib/format";
import { marketSetupSteps, setupRemaining } from "@/lib/market-setup";
import { MarketLifecycleAction } from "./MarketLifecycleAction";
import { TransactionSequence } from "./TransactionSequence";

const states = [
  "none",
  "scheduled",
  "open",
  "frozen",
  "awaiting resolution",
  "resolved",
  "redeemable",
  "archived",
];

/** After create-market: list the evidence's issuer tokens (pool + add_base, in order),
 * create every collateral's claim mints, then open the market (lifecycle 0). */
export function MarketSetupPanel({
  marketId,
  baseTokens,
  names = {},
}: {
  marketId: string;
  /** Ordered issuer tokens from the approved creation evidence; null when unknown. */
  baseTokens: string[] | null;
  names?: Record<string, string>;
}) {
  const admin = useAdmin();
  const query = useQuery({
    queryKey: ["market-chain", marketId, adminConfig.genesisHash],
    queryFn: async () => {
      const client = new SolanaClient(adminConfig);
      const info = await client.connection.getAccountInfo(key(marketId), "confirmed");
      return info ? client.market(key(marketId)) : null;
    },
    refetchInterval: 8_000,
  });
  if (query.isPending || query.isError) return <QueryStatus query={query} />;
  const market = query.data;
  if (!market)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Market {short(marketId, 6)} is not on chain yet. Sign create market first; this panel
        updates automatically.
      </p>
    );
  const tokens = baseTokens ?? [];
  const remaining = setupRemaining(market, tokens);
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-muted/45 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">Issuer listing, claim mints and opening</p>
        <Badge variant={market.state === 2 ? "positive" : "secondary"}>
          {states[market.state] ?? "unknown"}
        </Badge>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {market.bases} of {Math.max(tokens.length, market.bases)} issuer legs listed ·{" "}
        {remaining.missingClaims} claim-mint {remaining.missingClaims === 1 ? "set" : "sets"}{" "}
        missing. Each issuer token gets its protocol pool (admitting exactly its issuer controls)
        and an add_base transaction in the evidence order, then initialize_claims runs for the quote
        and every leg.
      </p>
      {baseTokens === null && market.bases === 0 && (
        <p className="text-xs text-destructive">
          The creation evidence for this market was not found in the review queue, so its issuer
          tokens are unknown. Reconcile the creation packet before listing issuers.
        </p>
      )}
      {market.state === 1 && !remaining.complete && (baseTokens !== null || market.bases > 0) && (
        <TransactionSequence
          key={`${marketId}:${tokens.join(",")}`}
          reviewLabel="Review listing and claim transactions"
          emptyMessage="Listing and claim mints are complete."
          onComplete={() => void query.refetch()}
          load={() =>
            marketSetupSteps(
              new SolanaClient(adminConfig),
              marketId,
              admin.account ?? adminConfig.marketAdmin,
              tokens,
              names,
            )
          }
        />
      )}
      {market.state === 1 && remaining.complete && (
        <MarketLifecycleAction marketId={marketId} action="openMarket" baseTokens={tokens} />
      )}
      {market.state >= 2 && (
        <p className="text-xs text-muted-foreground">
          The market has left the scheduled state; manage legs from Market controls.
        </p>
      )}
    </div>
  );
}
