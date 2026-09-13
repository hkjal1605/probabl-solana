"use client";

import { canonicalStringify } from "@conditional-stocks/market-data";
import { key, SolanaClient } from "@conditional-stocks/solana-client";
import { Alert, AlertDescription, AlertTitle } from "@conditional-stocks/ui-kit/alert";
import { Badge } from "@conditional-stocks/ui-kit/badge";
import { Button } from "@conditional-stocks/ui-kit/button";
import { Card, CardContent, CardHeader, CardTitle } from "@conditional-stocks/ui-kit/card";
import { Input } from "@conditional-stocks/ui-kit/input";
import { Label } from "@conditional-stocks/ui-kit/label";
import { Textarea } from "@conditional-stocks/ui-kit/textarea";
import { FileSearch, LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { formatUnits } from "viem";
import { useAdmin } from "@/components/providers/AdminProvider";
import { adminConfig } from "@/config/protocol";
import { adminRequest, type EvidenceView, fetchMarketMetadata } from "@/lib/admin-api";
import { dateTimeInputToUnixSeconds, unixSecondsToDateTimeInput } from "@/lib/date-time";
import { short } from "@/lib/format";
import {
  assertBatchPacket,
  type BatchPlan,
  type BatchResult,
  buildBatchPlans,
  defaultMarketCaps,
  loadBatchMints,
  MAX_BATCH_MARKETS,
  type MarketCaps,
  type MarketRow,
  type MarketSource,
  parseBaseMints,
  prepareMarketBatch,
  recoverBatchResults,
  type SharedMarketFields,
} from "@/lib/market-batch";
import { PacketCard } from "../ReviewPageModule/ReviewQueue";

type VerifiedMints = Awaited<ReturnType<typeof loadBatchMints>>;
const label = (value: string) =>
  value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const amount = (value: string, decimals: number) => {
  if (!/^[0-9]{1,39}$/.test(value)) return "Enter a raw integer";
  const result = formatUnits(BigInt(value), decimals);
  return result.length > 55 ? "Check this mint's precision carefully" : result;
};

export function CreateMarketForm() {
  const admin = useAdmin();
  const [marketSlug, setMarketSlug] = useState("");
  const [source, setSource] = useState<MarketSource | null>(null);
  const [mintInputs, setMintInputs] = useState("");
  const [verified, setVerified] = useState<VerifiedMints | null>(null);
  const [rows, setRows] = useState<MarketRow[]>([]);
  const [timing, setTiming] = useState({
    tradingOpen: "",
    tradingCutoff: "",
  });
  const [shared, setShared] = useState<Omit<SharedMarketFields, keyof typeof timing>>({
    metadataUri: "",
    sourceUrls: "",
  });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plans, setPlans] = useState<BatchPlan[]>([]);
  const [results, setResults] = useState<BatchResult[]>([]);
  const lock = useRef(false);
  const started = plans.length > 0;
  const updateResult = (index: number, result: BatchResult) =>
    setResults((current) => current.map((value, i) => (i === index ? result : value)));
  const run = async (action: (check: () => void) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action(admin.captureContext());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Batch operation failed");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const fetchSource = () =>
    run(async (check) => {
      setSource(null);
      setConfirmed(false);
      const snapshot = await fetchMarketMetadata<MarketSource>(admin.token ?? "", marketSlug);
      check();
      const defaults = {
        tradingOpen: unixSecondsToDateTimeInput(String(Math.floor(Date.now() / 1000))),
        tradingCutoff: unixSecondsToDateTimeInput(
          String(Math.floor(new Date(snapshot.normalized.endTime).getTime() / 1000)),
        ),
      };
      setSource(snapshot);
      setTiming(defaults);
      setShared({
        metadataUri: snapshot.normalized.canonicalUrl,
        sourceUrls: snapshot.normalized.canonicalUrl,
      });
    });
  const verifyMints = () =>
    run(async (check) => {
      setVerified(null);
      setRows([]);
      setConfirmed(false);
      const info = await loadBatchMints(new SolanaClient(adminConfig), parseBaseMints(mintInputs));
      check();
      setVerified(info);
      setRows(
        info.bases.map((mint) => ({
          mint,
          caps: defaultMarketCaps(mint.decimals, info.quote.decimals),
        })),
      );
    });
  const recover = async (batch: BatchPlan[], prior: BatchResult[], check: () => void) => {
    const response = await adminRequest<{ packets: EvidenceView[] }>(
      admin.token ?? "",
      "admin/evidence",
    );
    check();
    if (!Array.isArray(response.packets) || response.packets.length >= 1000)
      throw new Error(
        "The evidence list is incomplete or too large. Use the review queue to reconcile this batch.",
      );
    return recoverBatchResults(batch, prior, response.packets);
  };
  const submit = async (batch: BatchPlan[], prior: BatchResult[], check: () => void) => {
    const recovered = await recover(batch, prior, check);
    setResults(recovered);
    await prepareMarketBatch(batch, recovered, {
      check,
      update: updateResult,
      prepare: (plan) =>
        adminRequest<EvidenceView>(admin.token ?? "", "admin/evidence/creation/prepare", {
          method: "POST",
          body: JSON.stringify(plan.body),
        }),
    });
  };
  const prepare = () =>
    run(async (check) => {
      if (!source || !verified || !admin.account || !confirmed || started) return;
      const sharedWithTiming = { ...shared, tradingOpen: "", tradingCutoff: "" };
      for (const name of ["tradingOpen", "tradingCutoff"] as const) {
        try {
          sharedWithTiming[name] = dateTimeInputToUnixSeconds(timing[name]);
        } catch (error) {
          throw new Error(
            `${label(name)}: ${error instanceof Error ? error.message : "Invalid date and time"}`,
          );
        }
      }
      const client = new SolanaClient(adminConfig);
      const fresh = await loadBatchMints(
        client,
        rows.map((row) => row.mint.address),
      );
      check();
      if (canonicalStringify(fresh) !== canonicalStringify(verified))
        throw new Error(
          "Protocol roles, quote token or mint precision changed. Reload the mints and review again.",
        );
      const batch = buildBatchPlans({
        rows,
        quote: verified.quote,
        source,
        shared: sharedWithTiming,
        deployment: verified.deployment,
        owner: admin.account,
      });
      const accounts = await client.connection.getMultipleAccountsInfo(
        batch.map((plan) => key(plan.expectedMarketId)),
        "confirmed",
      );
      check();
      const existing = accounts.findIndex(Boolean);
      if (existing !== -1)
        throw new Error(
          "Market " +
            batch[existing]!.expectedMarketId +
            " already exists. Remove that base mint and manage its existing market instead.",
        );
      const pending: BatchResult[] = batch.map(() => ({ phase: "pending" }));
      setPlans(batch);
      setResults(pending);
      await submit(batch, pending, check);
    });
  const refreshPacket = (index: number, hash: string) =>
    run(async (check) => {
      const packet = await adminRequest<EvidenceView>(admin.token ?? "", "admin/evidence/" + hash);
      check();
      assertBatchPacket(plans[index]!, packet);
      updateResult(index, { phase: "prepared", packet });
    });

  return (
    <div className="space-y-5">
      <fieldset disabled={busy || started} className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>1. Choose one Polymarket condition</CardTitle>
          </CardHeader>
          <CardContent>
            <Label htmlFor="creation-market-slug">Polymarket market slug</Label>
            <div className="mt-2 flex gap-3">
              <Input
                id="creation-market-slug"
                aria-describedby="creation-slug-help"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={512}
                value={marketSlug}
                placeholder="clarity-act-signed-into-law-in-2026"
                onChange={(event) => {
                  setMarketSlug(event.target.value);
                  setSource(null);
                  setConfirmed(false);
                }}
              />
              <Button onClick={fetchSource} disabled={!marketSlug.trim()}>
                <FileSearch />
                Fetch and normalize
              </Button>
            </div>
            <p id="creation-slug-help" className="mt-2 text-xs text-muted-foreground">
              Paste the individual market slug, not a full URL. Fetch once and reuse its immutable
              metadata for every pair below.
            </p>
            {source && (
              <div className="mt-4 rounded-xl border bg-muted/45 p-4">
                <p className="font-semibold">{source.normalized.question}</p>
                <p className="mt-2 break-all font-mono text-xs">
                  Condition: {source.normalized.conditionId}
                </p>
                <p className="mt-2 text-xs">
                  Resolution source: {source.normalized.resolutionSource}
                </p>
                <p className="mt-2 text-xs">
                  {source.normalized.outcomes
                    .map((outcome) => `${outcome.label}: index set ${outcome.indexSet}`)
                    .join(" · ")}
                  {" · Source end: "}
                  {source.normalized.endTime}
                </p>
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer font-medium">Inspect source rules</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words">{source.normalized.rules}</p>
                </details>
              </div>
            )}
          </CardContent>
        </Card>
        {source && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>2. Add base tokens</CardTitle>
              </CardHeader>
              <CardContent>
                <Label htmlFor="base-mints">
                  Base mint addresses · one per line · maximum {MAX_BATCH_MARKETS}
                </Label>
                <Textarea
                  id="base-mints"
                  className="mt-2 font-mono"
                  rows={5}
                  spellCheck={false}
                  autoCapitalize="none"
                  placeholder={"TSLA mint address\nNVDA mint address\nBTC mint address"}
                  value={mintInputs}
                  onChange={(event) => {
                    setMintInputs(event.target.value);
                    setVerified(null);
                    setRows([]);
                    setConfirmed(false);
                  }}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Use Solana mint addresses, not symbols or wallet addresses. Native SOL uses its
                  wrapped-SOL mint. SPL Token and supported Token-2022 mints are checked against the
                  deployed program's token policy.
                </p>
                <Button className="mt-3" onClick={verifyMints} disabled={!mintInputs.trim()}>
                  Load and verify tokens
                </Button>
                {verified && (
                  <div className="mt-4 rounded-xl border p-4">
                    <Label htmlFor="batch-quote">
                      Shared quote mint · fixed by the deployed protocol
                    </Label>
                    <Input
                      id="batch-quote"
                      className="mt-2 font-mono"
                      readOnly
                      value={verified.quote.address}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {verified.quote.standard} · {verified.quote.decimals} decimals. This
                      deployment uses one quote mint. Other quote tokens cannot be enabled by an
                      admin-UI change.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
            {verified && rows.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>3. Define caps per pair and shared timing</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {rows.length} separate markets will share this Polymarket condition. Raw
                    defaults are scaled using each mint's verified decimals. Review every pair; caps
                    are per market, not per event.
                  </p>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {(["tradingOpen", "tradingCutoff"] as const).map((name) => (
                      <div key={name}>
                        <Label htmlFor={name}>{label(name)} · UTC</Label>
                        <Input
                          id={name}
                          type="datetime-local"
                          step={1}
                          min="1970-01-01T00:00:00"
                          max="9999-12-31T23:59:59"
                          required
                          aria-describedby="market-timing-help"
                          className="mt-2 font-mono"
                          value={timing[name]}
                          onChange={(event) => {
                            setTiming((current) => ({ ...current, [name]: event.target.value }));
                            setConfirmed(false);
                          }}
                        />
                      </div>
                    ))}
                    <p
                      id="market-timing-help"
                      className="text-xs text-muted-foreground sm:col-span-2"
                    >
                      Enter both times in UTC, not your local timezone. Opening defaults to now;
                      cutoff defaults to Polymarket's scheduled end. Seconds are preserved and
                      converted to Unix timestamps automatically when preparing the markets.
                    </p>
                    <div className="sm:col-span-2">
                      <Label htmlFor="metadataUri">Metadata URI</Label>
                      <Input
                        id="metadataUri"
                        className="mt-2 font-mono"
                        value={shared.metadataUri}
                        onChange={(event) => {
                          setShared((current) => ({ ...current, metadataUri: event.target.value }));
                          setConfirmed(false);
                        }}
                      />
                    </div>
                  </div>
                  {rows.map((row, index) => (
                    <div key={row.mint.address} className="rounded-xl border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-semibold">
                          Pair {index + 1}: {short(row.mint.address)} /{" "}
                          {short(verified.quote.address)}
                        </h3>
                        <Badge variant="outline">
                          {row.mint.standard} · base decimals {row.mint.decimals}
                        </Badge>
                      </div>
                      <p className="mt-2 break-all font-mono text-xs">
                        Base mint: {row.mint.address}
                      </p>
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        {(Object.keys(row.caps) as (keyof MarketCaps)[]).map((name) => (
                          <div key={name}>
                            <Label htmlFor={"pair-" + index + "-" + name}>{label(name)}</Label>
                            <Input
                              id={"pair-" + index + "-" + name}
                              className="mt-2 font-mono"
                              value={row.caps[name]}
                              onChange={(event) => {
                                setRows((current) =>
                                  current.map((r, i) =>
                                    i === index
                                      ? { ...r, caps: { ...r.caps, [name]: event.target.value } }
                                      : r,
                                  ),
                                );
                                setConfirmed(false);
                              }}
                            />
                            <p className="mt-1 text-xs text-muted-foreground">
                              {name === "priceTickRawX18"
                                ? "Raw quote/raw base ratio × 10¹⁸; a price increment, not an initial price."
                                : amount(
                                    row.caps[name],
                                    name === "baseStep" || name === "maxOrderQuantity"
                                      ? row.mint.decimals
                                      : verified.quote.decimals,
                                  ) +
                                  (name === "baseStep" || name === "maxOrderQuantity"
                                    ? " base units"
                                    : " quote units")}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div>
                    <Label htmlFor="sourceUrls">Evidence source URLs · one per line</Label>
                    <Textarea
                      id="sourceUrls"
                      className="mt-2"
                      value={shared.sourceUrls}
                      onChange={(event) => {
                        setShared((current) => ({ ...current, sourceUrls: event.target.value }));
                        setConfirmed(false);
                      }}
                    />
                  </div>
                  <label className="flex items-start gap-3 rounded-xl border p-4">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-[var(--brand)]"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    <span className="text-sm leading-6">
                      <strong className="block">
                        Immutable-field confirmation for all {rows.length} pairs
                      </strong>
                      I checked every base/quote mint, its decimals, YES/NO orientation, rules,
                      timing, step, tick and caps. Preparing evidence does not approve or sign
                      transactions.
                    </span>
                  </label>
                  <Button
                    className="w-full"
                    size="lg"
                    variant="brand"
                    onClick={prepare}
                    disabled={!confirmed}
                  >
                    {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}Prepare{" "}
                    {rows.length} market {rows.length === 1 ? "packet" : "packets"}
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </fieldset>
      {started && verified && (
        <>
          <Alert>
            <AlertTitle>4. Review and create each market</AlertTitle>
            <AlertDescription>
              {results.filter((result) => result.phase === "prepared").length} of {plans.length}{" "}
              evidence packets ready. Each pair has its own on-chain market, vaults, caps and
              settlement. Approval and wallet signatures remain explicit below. This is a sequence
              of independent operations, not one atomic transaction.
              <span className="mt-2 block">
                After creation, use{" "}
                <Link className="underline" href="/markets">
                  Market controls
                </Link>{" "}
                to initialize vaults and open each market. Prepared packets also remain available in
                the{" "}
                <Link className="underline" href="/review">
                  review queue
                </Link>{" "}
                after navigation or reload.
              </span>
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run(async (check) => setResults(await recover(plans, results, check)))}
            >
              Recover saved packets
            </Button>
            {results.some((result) => result.phase === "pending") && (
              <Button disabled={busy} onClick={() => run((check) => submit(plans, results, check))}>
                Prepare remaining unattempted pairs
              </Button>
            )}
          </div>
          {plans.map((plan, index) => {
            const result = results[index];
            return (
              <section key={plan.expectedMarketId} className="space-y-3 rounded-xl border p-4">
                <h3 className="font-semibold">
                  Pair {index + 1}: {short(plan.base.address)} / {short(plan.quote.address)}
                </h3>
                <p className="break-all font-mono text-xs">
                  Expected market: {plan.expectedMarketId}
                </p>
                <p role="status" className="text-sm">
                  {result?.phase}
                </p>
                {result?.phase === "uncertain" && (
                  <Alert variant="destructive">
                    <AlertTitle>Outcome needs checking</AlertTitle>
                    <AlertDescription>
                      {result.message} This request will not be retried automatically. Recover saved
                      packets or inspect the review queue before starting another batch.
                    </AlertDescription>
                  </Alert>
                )}
                {result?.phase === "prepared" && (
                  <fieldset disabled={busy}>
                    <PacketCard
                      packet={result.packet}
                      deployment={verified.deployment}
                      onDone={() => {
                        void refreshPacket(index, result.packet.envelope.packetHash);
                      }}
                    />
                  </fieldset>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
