"use client";

import { Alert, AlertDescription, AlertTitle } from "@conditional-stocks/ui-kit/alert";
import { Badge } from "@conditional-stocks/ui-kit/badge";
import { Button } from "@conditional-stocks/ui-kit/button";
import { Card, CardContent, CardHeader, CardTitle } from "@conditional-stocks/ui-kit/card";
import { Input } from "@conditional-stocks/ui-kit/input";
import { Label } from "@conditional-stocks/ui-kit/label";
import { Textarea } from "@conditional-stocks/ui-kit/textarea";
import { CheckCircle2, FileSearch, LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/providers/AdminProvider";
import { adminRequest, type EvidenceView } from "@/lib/admin-api";

interface Snapshot {
  normalized: {
    canonicalUrl: string;
    conditionId: string;
    endTime: string;
    question: string;
    resolutionSource: string;
    rules: string;
  };
  rawHash: string;
  snapshotId: string;
}
const initial = {
  baseStep: "1000",
  baseToken: "",
  maxMarketOpenNotional: "1000000000000",
  maxOrderNotional: "10000000000",
  maxOrderQuantity: "1000000000",
  maxWalletOpenNotional: "100000000000",
  metadataUri: "",
  minNotional: "1000000",
  priceTickRawX18: "10000000000000000",
  quoteToken: "",
  tradingOpen: "",
  tradingCutoff: "",
};
export function CreateMarketForm() {
  const admin = useAdmin();
  const [gammaMarketId, setGammaMarketId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [config, setConfig] = useState(initial);
  const [sourceUrls, setSourceUrls] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [packet, setPacket] = useState<EvidenceView | null>(null);
  const update = (name: keyof typeof initial, value: string) => {
    setConfirmed(false);
    setConfig((current) => ({ ...current, [name]: value }));
  };
  const fetchMetadata = async () => {
    setSnapshot(null);
    setConfirmed(false);
    setBusy(true);
    try {
      const result = await adminRequest<Snapshot>(
        admin.token ?? "",
        "admin/polymarket/metadata/fetch",
        { body: JSON.stringify({ gammaMarketId }), method: "POST" },
      );
      setSnapshot(result);
      setConfig((current) => ({
        ...current,
        tradingCutoff: String(Math.floor(new Date(result.normalized.endTime).getTime() / 1000)),
        tradingOpen: String(Math.floor(Date.now() / 1000)),
        metadataUri: result.normalized.canonicalUrl,
      }));
      setSourceUrls(result.normalized.canonicalUrl);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Metadata fetch failed");
    } finally {
      setBusy(false);
    }
  };
  const prepare = async () => {
    if (!snapshot || !admin.account || !confirmed || busy) return;
    setBusy(true);
    try {
      const result = await adminRequest<EvidenceView>(
        admin.token ?? "",
        "admin/evidence/creation/prepare",
        {
          body: JSON.stringify({
            attachments: [],
            config: { ...config, rules: snapshot.normalized.rules },
            metadataSnapshotId: snapshot.snapshotId,
            sourceUrls: sourceUrls
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
          }),
          method: "POST",
        },
      );
      setPacket(result);
      toast.success("Immutable creation packet prepared");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Packet preparation failed");
    } finally {
      setBusy(false);
    }
  };
  if (packet)
    return (
      <Alert>
        <CheckCircle2 />
        <AlertTitle>Creation packet ready for market-admin approval</AlertTitle>
        <AlertDescription>
          <span className="block break-all font-mono text-xs">{packet.envelope.packetHash}</span>
          <span className="mt-2 block">
            MARKET_ADMIN completes the checklist, approves this packet, and executes the reviewed
            transaction.
          </span>
          <Button asChild className="mt-4" variant="outline">
            <Link href="/review">Continue to review queue</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  return (
    <fieldset disabled={busy} className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>1. Fetch immutable source metadata</CardTitle>
            <Badge variant="outline">Polymarket Gamma ID</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input
              value={gammaMarketId}
              onChange={(event) => {
                setGammaMarketId(event.target.value);
                setSnapshot(null);
                setConfirmed(false);
              }}
              placeholder="Market ID"
            />
            <Button onClick={fetchMetadata} disabled={busy || !gammaMarketId}>
              {busy ? <LoaderCircle className="animate-spin" /> : <FileSearch />}Fetch and normalize
            </Button>
          </div>
          {snapshot && (
            <div className="mt-5 rounded-xl border bg-muted/45 p-4">
              <p className="font-semibold">{snapshot.normalized.question}</p>
              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Condition ID</dt>
                  <dd className="mt-1 break-all font-mono">{snapshot.normalized.conditionId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Resolution source</dt>
                  <dd className="mt-1">{snapshot.normalized.resolutionSource}</dd>
                </div>
              </dl>
            </div>
          )}
        </CardContent>
      </Card>
      {snapshot && (
        <Card>
          <CardHeader>
            <CardTitle>2. Define local market caps and timing</CardTitle>
            <p className="text-sm text-muted-foreground">
              All amounts below are raw integers. Defaults assume base6 / quote6: one quote token = 1000000;
              price tick 10000000000000000 = 0.01 quote per base. Verify the SPL mint addresses and decimals
              independently. Prices use v2 raw quote/raw base ratios × 1e18.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              {Object.entries(config).map(([name, value]) => (
                <div key={name}>
                  <Label htmlFor={name}>{label(name)}</Label>
                  <Input
                    id={name}
                    className="mt-2 font-mono"
                    value={value}
                    onChange={(event) => update(name as keyof typeof initial, event.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4">
              <Label htmlFor="sourceUrls">Evidence source URLs · one per line</Label>
              <Textarea
                id="sourceUrls"
                className="mt-2"
                value={sourceUrls}
                onChange={(event) => {
                  setSourceUrls(event.target.value);
                  setConfirmed(false);
                }}
              />
            </div>
            <label className="mt-5 flex items-start gap-3 rounded-xl border p-4">
              <input
                className="mt-1 size-4 accent-[var(--brand)]"
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span className="text-sm leading-6">
                <strong className="block">Immutable-field confirmation</strong>
                <span className="text-muted-foreground">
                  I checked the stock and quote tokens, YES/NO orientation, rules hash inputs,
                  opening, cutoff, price tick, step, and every risk cap against the source packet.
                </span>
              </span>
            </label>
            <Button
              className="mt-5 w-full"
              size="lg"
              variant="brand"
              onClick={prepare}
              disabled={busy || !confirmed}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}Prepare
              append-only evidence packet
            </Button>
          </CardContent>
        </Card>
      )}
    </fieldset>
  );
}
function label(value: string) {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}
