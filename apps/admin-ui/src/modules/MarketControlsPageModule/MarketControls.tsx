"use client";

import { lifecycleTransaction } from "@conditional-stocks/solana-client/admin";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCopy, Snowflake } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { QueryStatus } from "@/components/data/QueryStatus";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { adminConfig } from "@/config/protocol";
import { requestJson } from "@/lib/admin-api";
import { short } from "@/lib/format";
import { MarketLifecycleAction } from "./MarketLifecycleAction";

interface Market {
  id: string;
  maxMarketOpenNotional: string | null;
  maxOrderNotional: string | null;
  maxWalletOpenNotional: string | null;
  state: number;
  tradingCutoff: string | null;
}
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
export function MarketControls() {
  const query = useQuery({
    queryKey: ["markets", adminConfig.chainId],
    queryFn: ({ signal }) => requestJson<{ markets: Market[] }>("/api/indexer/markets", { signal }),
    refetchInterval: 10_000,
  });
  const markets = query.data?.markets ?? [];
  return (
    <div className="grid gap-4">
      <QueryStatus query={query} />
      {markets.map((market) => (
        <MarketControl key={market.id} market={market} />
      ))}
      {query.isSuccess && markets.length === 0 && (
        <div className="flex min-h-64 items-center justify-center rounded-xl bg-card text-sm text-muted-foreground">
          No canonical markets are indexed.
        </div>
      )}
    </div>
  );
}
function MarketControl({ market }: { market: Market }) {
  const admin = useAdmin();
  const [reason, setReason] = useState("");
  const [payload, setPayload] = useState<string | null>(null);
  const build = () => {
    if (!adminConfig.marketRegistry) {
      toast.error("Market registry address is not configured");
      return;
    }
    const transaction = lifecycleTransaction(
      adminConfig,
      admin.account ?? adminConfig.marketAdmin,
      market.id,
      1,
      reason,
    );
    setPayload(
      JSON.stringify(
        {
          ...transaction,
          metadata: { marketId: market.id, reason },
        },
        null,
        2,
      ),
    );
  };
  return (
    <Card className="ring-0">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="font-mono text-sm">{short(market.id, 8)}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Cutoff block time {market.tradingCutoff ?? "not indexed"}
          </p>
        </div>
        <Badge
          variant={market.state === 2 ? "positive" : market.state === 3 ? "warning" : "secondary"}
        >
          {states[market.state] ?? "unknown"}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 rounded-xl bg-muted/45 p-4 text-xs sm:grid-cols-3">
          <Fact label="Order cap" value={market.maxOrderNotional ?? "—"} />
          <Fact label="Wallet open-order cap" value={market.maxWalletOpenNotional ?? "—"} />
          <Fact label="Market open-order cap" value={market.maxMarketOpenNotional ?? "—"} />
        </div>
        {market.state === 1 && <MarketLifecycleAction marketId={market.id} action="openMarket" />}
        {market.state === 2 && (
          <MarketLifecycleAction marketId={market.id} action="freezeAtCutoff" />
        )}
        {(market.state === 1 || market.state === 2) && (
          <Dialog>
            <DialogTrigger render={<Button className="mt-4" variant="destructive" />}>
              <Snowflake />
              Prepare emergency freeze
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Prepare emergency freeze</DialogTitle>
                <DialogDescription>
                  Freeze this market with MARKET_ADMIN, or export the payload for a guardian. The
                  contract enforces these roles for every transaction.
                </DialogDescription>
              </DialogHeader>
              <div>
                <Label htmlFor={`reason-${market.id}`}>Incident reason</Label>
                <Input
                  id={`reason-${market.id}`}
                  className="mt-2"
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setPayload(null);
                  }}
                  placeholder="Specific, non-empty incident reference"
                />
              </div>
              <Button variant="destructive" onClick={build} disabled={!reason}>
                Build freeze payload
              </Button>
              {payload && (
                <div className="rounded-xl bg-muted p-3">
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {payload}
                  </pre>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(payload)
                        .then(() => toast.success("Payload copied"))
                    }
                  >
                    <ClipboardCopy />
                    Copy Solana instructions
                  </Button>
                </div>
              )}
              {reason.trim() && (
                <MarketLifecycleAction
                  key={reason}
                  marketId={market.id}
                  action="freezeMarket"
                  reason={reason.trim()}
                />
              )}
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 break-all font-mono">{value}</p>
    </div>
  );
}
