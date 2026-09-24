"use client";

import { MAX_BASES, SolanaClient } from "@conditional-stocks/solana-client";
import { useQuery } from "@tanstack/react-query";
import { Ban, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { QueryStatus } from "@/components/data/QueryStatus";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminConfig } from "@/config/protocol";
import { short } from "@/lib/format";
import {
  addIssuerSteps,
  HALT_TEXT,
  type LegRow,
  type MarketLegsView,
  pendingClaimSteps,
  readMarketLegs,
  setBaseAllowed,
  setBaseStep,
} from "@/lib/market-setup";
import { TransactionSequence } from "./TransactionSequence";

const multiplier = (value: number) => (Number.isFinite(value) ? value.toFixed(6) : "—");

export function IssuerLegs({ marketId }: { marketId: string }) {
  const admin = useAdmin();
  const query = useQuery({
    queryKey: ["market-chain", marketId, "legs", adminConfig.genesisHash],
    queryFn: () => readMarketLegs(new SolanaClient(adminConfig), marketId),
    refetchInterval: 15_000,
  });
  if (query.isPending || query.isError) return <QueryStatus query={query} />;
  const view = query.data;
  const isAdmin = admin.account === view.roles.marketAdmin;
  const canAdd =
    isAdmin &&
    view.market.bases < MAX_BASES &&
    (view.market.state === 1 || view.market.state === 2) &&
    BigInt(view.market.terms.trading_cutoff.toString()) > BigInt(Math.floor(Date.now() / 1000));
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          Issuer legs · {view.market.bases} of {MAX_BASES} · share decimals {view.shareDecimals}
        </p>
        {canAdd && (
          <AddIssuer marketId={marketId} view={view} onDone={() => void query.refetch()} />
        )}
      </div>
      {view.legs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No issuer token is listed yet. Complete the market setup before opening.
        </p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Leg</TableHead>
              <TableHead>Issuer token</TableHead>
              <TableHead>Decimals · scale</TableHead>
              <TableHead>Multiplier listing → live</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.legs.map((leg) => (
              <TableRow key={leg.collateral}>
                <TableCell className="font-mono">{leg.collateral}</TableCell>
                <TableCell>
                  <p className="font-semibold">{leg.symbol ?? "Unknown symbol"}</p>
                  <p className="font-mono text-muted-foreground" title={leg.mint}>
                    {short(leg.mint, 6)}
                  </p>
                </TableCell>
                <TableCell className="font-mono">
                  {leg.decimals} · {String(leg.scale)}
                </TableCell>
                <TableCell className="font-mono">
                  {multiplier(leg.listingMultiplierValue)} → {multiplier(leg.multiplierValue)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={leg.active ? "positive" : "destructive"}>
                      {leg.active ? "active" : "delisted"}
                    </Badge>
                    <Badge variant={leg.ready ? "secondary" : "warning"}>
                      {leg.ready ? "claims ready" : "claims missing"}
                    </Badge>
                    {leg.tradable ? (
                      <Badge variant="positive">tradable</Badge>
                    ) : (
                      leg.halt &&
                      leg.halt !== "delisted" && (
                        <Badge variant="warning" title={HALT_TEXT[leg.halt]}>
                          {leg.halt}
                        </Badge>
                      )
                    )}
                  </div>
                  {leg.halt && leg.halt !== "delisted" && (
                    <p className="mt-1 text-muted-foreground">{HALT_TEXT[leg.halt]}</p>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <SetBase
                    marketId={marketId}
                    view={view}
                    leg={leg}
                    onDone={() => void query.refetch()}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.market.state === 2 && admin.account && view.legs.some((leg) => !leg.ready) && (
        <TransactionSequence
          reviewLabel="Review missing claim-mint transactions"
          emptyMessage="Every listed leg has its claim mints."
          onComplete={() => void query.refetch()}
          load={() =>
            pendingClaimSteps(new SolanaClient(adminConfig), marketId, admin.account ?? "")
          }
        />
      )}
    </div>
  );
}

function SetBase({
  marketId,
  view,
  leg,
  onDone,
}: {
  marketId: string;
  view: MarketLegsView;
  leg: LegRow;
  onDone: () => void;
}) {
  const admin = useAdmin();
  const active = !leg.active;
  if (!setBaseAllowed(admin.account, view.roles, active) || view.market.state > 3) return null;
  const label = active ? "Relist" : "Delist";
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" variant={active ? "outline" : "destructive"} />}>
        {active ? <RotateCcw /> : <Ban />}
        {label}
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {label} {leg.symbol ?? short(leg.mint, 6)} (leg {leg.collateral})
          </DialogTitle>
          <DialogDescription>
            {active
              ? "Relisting lets this issuer's claims trade again once its live checks pass. Only the market admin may relist."
              : "Delisting stops new exposure on this issuer leg: its resting asks become publicly releasable, while split, merge and redemption of existing claims follow contract rules. The guardian or market admin may delist."}
          </DialogDescription>
        </DialogHeader>
        <TransactionSequence
          reviewLabel={`Review ${label.toLowerCase()} transaction`}
          onComplete={onDone}
          load={async () =>
            setBaseStep(adminConfig, admin.account ?? "", view, marketId, leg.collateral, active)
          }
        />
      </DialogContent>
    </Dialog>
  );
}

function AddIssuer({
  marketId,
  view,
  onDone,
}: {
  marketId: string;
  view: MarketLegsView;
  onDone: () => void;
}) {
  const admin = useAdmin();
  const [mint, setMint] = useState("");
  const [symbol, setSymbol] = useState<string | null>(null);
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Plus />
        Add issuer token
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Whitelist another issuer token</DialogTitle>
          <DialogDescription>
            Lists the same asset from another issuer as leg {view.market.bases + 1} of {MAX_BASES}.
            It needs at least {view.shareDecimals} decimals, must not be paused, and its pool vault
            must not be frozen. A new pool admits exactly the mint's issuer controls.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor={`add-issuer-${marketId}`}>Issuer token mint</Label>
          <Input
            id={`add-issuer-${marketId}`}
            className="mt-2 font-mono"
            spellCheck={false}
            autoCapitalize="none"
            value={mint}
            onChange={(event) => {
              setMint(event.target.value.trim());
              setSymbol(null);
            }}
            placeholder="Token-2022 or SPL mint address"
          />
        </div>
        {symbol && <p className="text-xs">Verified token symbol: {symbol}</p>}
        {mint && (
          <TransactionSequence
            key={mint}
            reviewLabel="Verify token and review listing transactions"
            onComplete={onDone}
            load={async () => {
              const result = await addIssuerSteps(
                new SolanaClient(adminConfig),
                marketId,
                admin.account ?? "",
                mint,
              );
              setSymbol(result.symbol);
              return result.steps;
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
