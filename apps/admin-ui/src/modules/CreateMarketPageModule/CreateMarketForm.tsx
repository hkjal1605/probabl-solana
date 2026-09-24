"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { key, SolanaClient } from "@conditional-stocks/solana-client";
import { FileSearch, LoaderCircle, Plus, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { adminConfig } from "@/config/protocol";
import { adminRequest, type EvidenceView, fetchMarketMetadata } from "@/lib/admin-api";
import { dateTimeInputToUnixSeconds, unixSecondsToDateTimeInput } from "@/lib/date-time";
import { short } from "@/lib/format";
import {
  defaultShareDecimals,
  issuerLegNotes,
  type MintCheck,
  type MintInfo,
  parseShareDecimals,
} from "@/lib/issuer-mints";
import {
  assertBatchPacket,
  type BatchPlan,
  type BatchResult,
  buildBatchPlans,
  defaultMarketCaps,
  loadBatchMints,
  MAX_BATCH_MARKETS,
  type MarketCaps,
  type MarketSource,
  mintIdentity,
  parseAssetRows,
  prepareMarketBatch,
  recoverBatchResults,
  resolveRows,
  type SharedMarketFields,
  type VerifiedMints,
} from "@/lib/market-batch";
import { MarketSetupPanel } from "../MarketControlsPageModule/MarketSetupPanel";
import { PacketCard } from "../ReviewPageModule/ReviewQueue";

const WAD = 10n ** 18n;
interface AssetInput {
  id: number;
  mints: string;
}
interface AssetRow {
  mints: string[];
  shareDecimals: string;
  caps: MarketCaps;
}
const label = (value: string) =>
  value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const amount = (value: string, decimals: number) => {
  if (!/^[0-9]{1,39}$/.test(value)) return "Enter a raw integer";
  const result = formatTokenAmount(BigInt(value), decimals);
  return result.length > 55 ? "Check this precision carefully" : result;
};
const quantityField = (name: keyof MarketCaps) =>
  name === "baseStep" || name === "maxOrderQuantity";
const tickText = (tick: string, shareDecimals: number, quoteDecimals: number) => {
  if (!/^[0-9]{1,39}$/.test(tick)) return "Enter a raw integer";
  const perShare = (BigInt(tick) * 10n ** BigInt(shareDecimals)) / WAD;
  return `≈ ${formatTokenAmount(perShare, quoteDecimals)} quote per share. Quote raw per share unit × 10¹⁸; a price increment, not an initial price.`;
};
const legName = (mint: MintInfo) => mint.symbol ?? short(mint.address);
const marketTitle = (legs: MintInfo[]) => legs.map(legName).join(" · ");

export function CreateMarketForm() {
  const admin = useAdmin();
  const [marketSlug, setMarketSlug] = useState("");
  const [source, setSource] = useState<MarketSource | null>(null);
  const [assets, setAssets] = useState<AssetInput[]>([{ id: 0, mints: "" }]);
  const nextId = useRef(1);
  const [verified, setVerified] = useState<VerifiedMints | null>(null);
  const [rows, setRows] = useState<AssetRow[]>([]);
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
  const resolved = verified ? resolveRows(verified, rows) : null;
  const blocked = !resolved || resolved.problems.some((list) => list.length > 0);
  const updateResult = (index: number, result: BatchResult) =>
    setResults((current) => current.map((value, i) => (i === index ? result : value)));
  const resetVerification = () => {
    setVerified(null);
    setRows([]);
    setConfirmed(false);
  };
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
      resetVerification();
      const parsed = parseAssetRows(assets.map((asset) => asset.mints));
      const info = await loadBatchMints(new SolanaClient(adminConfig), parsed);
      check();
      setVerified(info);
      setRows(
        parsed.map((mints) => {
          const legs = mints
            .map((address) => info.checks[address])
            .filter((c): c is Extract<MintCheck, { ok: true }> => Boolean(c?.ok))
            .map((c) => c.mint);
          const shareDecimals = legs.length ? defaultShareDecimals(legs) : 6;
          return {
            mints,
            shareDecimals: String(shareDecimals),
            caps: defaultMarketCaps(shareDecimals, info.quote.decimals),
          };
        }),
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
        rows.map((row) => row.mints),
      );
      check();
      if (mintIdentity(fresh) !== mintIdentity(verified))
        throw new Error(
          "Protocol roles, quote token, mint precision or issuer controls changed. Reload the tokens and review again.",
        );
      const live = resolveRows(fresh, rows);
      const problem = live.problems.findIndex((list) => list.length > 0);
      if (problem !== -1) {
        setVerified(fresh);
        setConfirmed(false);
        throw new Error(`Market ${problem + 1}: ${live.problems[problem]![0]}`);
      }
      const batch = buildBatchPlans({
        rows: live.rows,
        quote: fresh.quote,
        source,
        shared: sharedWithTiming,
        deployment: fresh.deployment,
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
            " already exists. Remove that asset market and manage the existing one instead.",
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
  const updateRow = (index: number, change: (row: AssetRow) => AssetRow) => {
    setRows((current) => current.map((row, i) => (i === index ? change(row) : row)));
    setConfirmed(false);
  };

  return (
    <div className="flex flex-col gap-5">
      <fieldset disabled={busy || started} className="flex flex-col gap-5">
        <Card className="ring-0">
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
              metadata for every asset market below.
            </p>
            {source && (
              <div className="mt-4 rounded-xl bg-secondary p-4">
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
            <Card className="ring-0">
              <CardHeader>
                <CardTitle>2. Add asset markets and their issuer tokens</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Each market is one order book for one asset (for example NVDA) that lists 1 to 3
                  whitelisted issuer tokens of that same stock, such as xStocks NVDAx, Ondo NVDAon
                  and Remora NVDAr, against the shared quote. Add another market for another asset
                  of this event (for example TSLA). Maximum {MAX_BATCH_MARKETS} markets.
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {assets.map((asset, index) => (
                  <div key={asset.id} className="rounded-xl bg-secondary p-4">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`asset-mints-${asset.id}`}>
                        Market {index + 1} · issuer token mints · one per line · leg order
                      </Label>
                      {assets.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove market ${index + 1}`}
                          onClick={() => {
                            setAssets((current) => current.filter((item) => item.id !== asset.id));
                            resetVerification();
                          }}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      id={`asset-mints-${asset.id}`}
                      className="mt-2 font-mono"
                      rows={3}
                      spellCheck={false}
                      autoCapitalize="none"
                      placeholder={"NVDAx mint address\nNVDAon mint address\nNVDAr mint address"}
                      value={asset.mints}
                      onChange={(event) => {
                        const value = event.target.value;
                        setAssets((current) =>
                          current.map((item) =>
                            item.id === asset.id ? { ...item, mints: value } : item,
                          ),
                        );
                        resetVerification();
                      }}
                    />
                  </div>
                ))}
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    disabled={assets.length >= MAX_BATCH_MARKETS}
                    onClick={() => {
                      setAssets((current) => [...current, { id: nextId.current++, mints: "" }]);
                      resetVerification();
                    }}
                  >
                    <Plus />
                    Add another asset market
                  </Button>
                  <Button
                    onClick={verifyMints}
                    disabled={assets.some((asset) => !asset.mints.trim())}
                  >
                    Load and verify tokens
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use Solana mint addresses, not symbols or wallet addresses. Every token is checked
                  against the deployed program's token policy, including its issuer controls
                  (permanent delegate, pausable, default account state, scaled UI amount, transfer
                  hook, confidential transfers). Paused tokens, tokens with a configured transfer
                  hook and default-frozen tokens whose pool vault is not thawed are rejected.
                </p>
                {verified && (
                  <div className="rounded-xl bg-secondary p-4">
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
                      {verified.quote.symbol ? `${verified.quote.symbol} · ` : ""}
                      {verified.quote.standard} · {verified.quote.decimals} decimals. This
                      deployment uses one quote mint. Other quote tokens cannot be enabled by an
                      admin-UI change.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
            {verified && rows.length > 0 && resolved && (
              <Card className="ring-0">
                <CardHeader>
                  <CardTitle>3. Review issuer legs, share units, caps and shared timing</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {rows.length} {rows.length === 1 ? "market" : "separate markets"} will share
                    this Polymarket condition. Quantities (step, maximum quantity) are in share
                    units of 10^-share-decimals of one share; every leg needs at least that many
                    decimals. Notional caps are quote raw units. Review every market.
                  </p>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
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
                    <AssetMarketReview
                      key={row.mints.join(",")}
                      index={index}
                      row={row}
                      checks={row.mints.map(
                        (address): MintCheck =>
                          verified.checks[address] ?? {
                            ok: false,
                            address,
                            error: "Token not verified",
                          },
                      )}
                      quote={verified.quote}
                      problems={resolved.problems[index] ?? []}
                      onChange={(change) => updateRow(index, change)}
                    />
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
                  <label
                    htmlFor="immutable-field-confirmation"
                    className="flex items-start gap-3 rounded-xl bg-secondary p-4"
                  >
                    <Checkbox
                      id="immutable-field-confirmation"
                      className="mt-1"
                      checked={confirmed}
                      disabled={blocked}
                      onCheckedChange={setConfirmed}
                    />
                    <span className="text-sm leading-6">
                      <strong className="block">
                        Immutable-field confirmation for all {rows.length}{" "}
                        {rows.length === 1 ? "market" : "markets"}
                      </strong>
                      I checked every issuer token (same underlying asset, leg order, issuer
                      controls, decimals, multiplier), the quote mint, share decimals, YES/NO
                      orientation, rules, timing, step, tick and caps. Preparing evidence does not
                      approve or sign transactions.
                    </span>
                  </label>
                  <Button
                    className="w-full"
                    size="lg"
                    variant="default"
                    onClick={prepare}
                    disabled={!confirmed || blocked}
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
            <AlertTitle>4. Review, create, list issuers and open each market</AlertTitle>
            <AlertDescription>
              {results.filter((result) => result.phase === "prepared").length} of {plans.length}{" "}
              evidence packets ready. Each asset market has its own on-chain order book, caps and
              settlement; its issuer claims stay segregated per issuer. Approval and wallet
              signatures remain explicit below. This is a sequence of independent operations, not
              one atomic transaction.
              <span className="mt-2 block">
                After create market confirms, sign the listed issuer (pool and add_base) and claim
                mint transactions in order, then open the market. The same steps are available in{" "}
                <Link className="underline" href="/markets">
                  Market controls
                </Link>
                . Prepared packets also remain available in the{" "}
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
                Prepare remaining unattempted markets
              </Button>
            )}
          </div>
          {plans.map((plan, index) => {
            const result = results[index];
            return (
              <section
                key={plan.expectedMarketId}
                className="flex flex-col gap-3 rounded-xl bg-secondary p-4"
              >
                <h3 className="font-semibold">
                  Market {index + 1}: {marketTitle(plan.legs)} / {legName(plan.quote)}
                </h3>
                <p className="break-all font-mono text-xs">
                  Expected market: {plan.expectedMarketId}
                </p>
                <p className="text-xs">
                  {plan.legs.length} issuer {plan.legs.length === 1 ? "leg" : "legs"} · share
                  decimals {plan.shareDecimals}
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
                  <fieldset disabled={busy} className="flex flex-col gap-3">
                    <PacketCard
                      packet={result.packet}
                      deployment={verified.deployment}
                      onDone={() => {
                        void refreshPacket(index, result.packet.envelope.packetHash);
                      }}
                    />
                    {result.packet.status === "approved" && (
                      <MarketSetupPanel
                        marketId={plan.expectedMarketId}
                        baseTokens={plan.baseTokens}
                        names={Object.fromEntries(
                          plan.legs.map((leg) => [leg.address, legName(leg)]),
                        )}
                      />
                    )}
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

function AssetMarketReview({
  index,
  row,
  checks,
  quote,
  problems,
  onChange,
}: {
  index: number;
  row: AssetRow;
  checks: MintCheck[];
  quote: MintInfo;
  problems: string[];
  onChange: (change: (row: AssetRow) => AssetRow) => void;
}) {
  let shareDecimals: number | null = null;
  try {
    shareDecimals = parseShareDecimals(row.shareDecimals);
  } catch {
    shareDecimals = null;
  }
  const verifiedLegs = checks.flatMap((check) => (check.ok ? [check.mint] : []));
  return (
    <div className="rounded-xl bg-secondary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          Market {index + 1}: {verifiedLegs.length ? marketTitle(verifiedLegs) : "unverified"} /{" "}
          {legName(quote)}
        </h3>
        <Badge variant={problems.length ? "destructive" : "positive"}>
          {problems.length ? `${problems.length} to fix` : `${checks.length} issuer legs ready`}
        </Badge>
      </div>
      <ol className="mt-3 flex flex-col gap-2">
        {checks.map((check, leg) => (
          <li
            key={check.ok ? check.mint.address : check.address}
            className="rounded-lg bg-background/60 p-3 text-xs leading-5"
          >
            {check.ok ? (
              <IssuerLegSummary leg={leg + 1} mint={check.mint} shareDecimals={shareDecimals} />
            ) : (
              <>
                <p className="font-semibold">Leg {leg + 1} · not listable</p>
                <p className="break-all font-mono">{check.address}</p>
                <p className="text-destructive">{check.error}</p>
              </>
            )}
          </li>
        ))}
      </ol>
      {problems.length > 0 && (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Fix before preparing</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor={`market-${index}-shareDecimals`}>Share decimals</Label>
          <Input
            id={`market-${index}-shareDecimals`}
            className="mt-2 font-mono sm:max-w-40"
            inputMode="numeric"
            value={row.shareDecimals}
            onChange={(event) => {
              const value = event.target.value;
              onChange((current) => {
                let caps = current.caps;
                try {
                  caps = defaultMarketCaps(parseShareDecimals(value), quote.decimals);
                } catch {
                  // Keep the caps until the precision is valid.
                }
                return { ...current, shareDecimals: value, caps };
              });
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Default 6 (Backpack precision); must not exceed any leg's decimals. Changing it resets
            this market's caps to share-unit defaults.
          </p>
        </div>
        {(Object.keys(row.caps) as (keyof MarketCaps)[]).map((name) => (
          <div key={name}>
            <Label htmlFor={`market-${index}-${name}`}>{label(name)}</Label>
            <Input
              id={`market-${index}-${name}`}
              className="mt-2 font-mono"
              value={row.caps[name]}
              onChange={(event) => {
                const value = event.target.value;
                onChange((current) => ({ ...current, caps: { ...current.caps, [name]: value } }));
              }}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {shareDecimals === null
                ? "Set valid share decimals first"
                : name === "priceTickRawX18"
                  ? tickText(row.caps[name], shareDecimals, quote.decimals)
                  : quantityField(name)
                    ? `${amount(row.caps[name], shareDecimals)} shares`
                    : `${amount(row.caps[name], quote.decimals)} quote units`}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function IssuerLegSummary({
  leg,
  mint,
  shareDecimals,
}: {
  leg: number;
  mint: MintInfo;
  shareDecimals: number | null;
}) {
  const notes = issuerLegNotes(mint);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">
          Leg {leg} · {mint.symbol ?? "No symbol"}
          {mint.name ? ` · ${mint.name}` : ""}
        </p>
        <Badge variant="outline">
          {mint.standard} · {mint.decimals} decimals
        </Badge>
        {shareDecimals !== null && mint.decimals >= shareDecimals && (
          <Badge variant="outline">scale 10^{mint.decimals - shareDecimals}</Badge>
        )}
        {mint.issuer.paused && <Badge variant="destructive">paused</Badge>}
        {mint.issuer.defaultFrozen && <Badge variant="warning">default frozen</Badge>}
        {mint.issuer.transferHookExtension && <Badge variant="secondary">hook unset</Badge>}
      </div>
      <p className="mt-1 break-all font-mono">{mint.address}</p>
      <p className="mt-1">
        Issuer controls ({mint.issuer.controls}):{" "}
        {mint.issuer.controlNames.length ? mint.issuer.controlNames.join(", ") : "none"}
      </p>
      <p>
        Live multiplier {mint.issuer.multiplierValue} · protocol pool{" "}
        {mint.pool?.admitted === null || !mint.pool
          ? "will be created"
          : `exists (admits ${mint.pool.admitted})`}
      </p>
      {notes.map((note) => (
        <p key={note} className="text-muted-foreground">
          {note}
        </p>
      ))}
    </>
  );
}
