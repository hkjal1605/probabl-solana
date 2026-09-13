"use client";
import { formatTokenAmount } from "@conditional-stocks/domain";
import { Button } from "@conditional-stocks/ui-kit/button";
import { Input } from "@conditional-stocks/ui-kit/input";
import { Label } from "@conditional-stocks/ui-kit/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conditional-stocks/ui-kit/select";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { Segmented } from "@/components/ui/segmented";
import { useOrderTicket } from "@/hooks/useOrderTicket";
import { usePositions } from "@/hooks/useProtocolData";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import type { MarketView } from "@/lib/api/types";
import { formatNumber, formatUsd } from "@/lib/format/display";
import { marketPriceBound, quantityForSpend } from "@/lib/trading/entry";

export function OrderTicket({ market }: { market: MarketView }) {
  const t = useOrderTicket({ market });
  const quantityLabel = formatTokenAmount(
    BigInt(t.preview.quantityRaw),
    market.baseTokenDecimals,
  );
  const prefill = useUiStore((s) => s.prefill);
  const setPrefill = useUiStore((s) => s.setPrefill);
  const assets = useWalletAssets([market]),
    positions = usePositions();
  const [kind, setKind] = useState<"Limit" | "Market">("Limit");
  const [entry, setEntry] = useState<"Quantity" | "Spend">("Quantity");
  const [spend, setSpend] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  // A close-position intent is data only: it never signs or submits automatically.
  useEffect(() => {
    if (!prefill || prefill.marketId !== market.id) return;
    t.setBranch(prefill.branch);
    t.setSide("sell");
    t.setFunding("claim");
    t.setQuantity(prefill.quantity);
    t.setPrice(
      (prefill.branch === "YES" ? market.yes : market.no).bestBidExact ?? "",
    );
    t.setPreparation(null);
    setEntry("Quantity");
    setKind("Limit");
    setPrefill(null);
  }, [
    prefill,
    market.id,
    market.yes,
    market.no,
    t.setBranch,
    t.setSide,
    t.setFunding,
    t.setQuantity,
    t.setPrice,
    t.setPreparation,
    setPrefill,
  ]);
  const edit = (action: () => void) => {
    t.setPreparation(null);
    setEntryError(null);
    action();
  };
  const priceFor = (
    branch: "YES" | "NO",
    side: "buy" | "sell",
    orderKind = kind,
  ) => {
    try {
      return orderKind === "Market"
        ? marketPriceBound(market, branch, side)
        : ((side === "buy"
            ? (branch === "YES" ? market.yes : market.no).bestAskExact
            : (branch === "YES" ? market.yes : market.no).bestBidExact) ?? "");
    } catch {
      return "";
    }
  };
  const outcome = (wins: boolean) =>
    t.side === "buy"
      ? wins
        ? `${quantityLabel} ${market.ticker}`
        : t.funding === "whole"
          ? `${formatUsd(t.preview.cost)} cash claim`
          : "No payout (active claim only)"
      : wins
        ? `${formatUsd(t.preview.cost)} cash claim`
        : t.funding === "whole"
          ? `${quantityLabel} ${market.ticker}`
          : "No payout (active claim only)";
  const prepared = t.preparation;
  const token = t.side === "buy" ? market.quoteToken : market.baseToken;
  const position = positions.positions.find((p) => p.marketId === market.id);
  const claim = position
    ? t.side === "buy"
      ? t.branch === "YES"
        ? position.quoteYes
        : position.quoteNo
      : t.branch === "YES"
        ? position.stockYes
        : position.stockNo
    : null;
  const wholeBalance = assets.balances.find((a) => a.token === token)?.balance;
  const available =
    t.funding === "whole"
      ? wholeBalance
        ? (
            BigInt(wholeBalance.canonicalBalance) +
            BigInt(wholeBalance.creditBalances?.[market.id] ?? "0")
          ).toString()
        : null
      : claim;
  const balanceError =
    t.funding === "whole" ? assets.isError : positions.isError;
  const maxQuantity = () =>
    edit(() => {
      if (available === null || balanceError) return;
      try {
        const value =
          t.side === "buy"
            ? quantityForSpend(
                formatTokenAmount(BigInt(available), market.quoteTokenDecimals),
                t.price,
                market,
              )
            : formatTokenAmount(
                (BigInt(available) / BigInt(market.baseStep)) *
                  BigInt(market.baseStep),
                market.baseTokenDecimals,
              );
        setEntry("Quantity");
        t.setQuantity(value);
      } catch (error) {
        setEntryError(
          error instanceof Error
            ? error.message
            : "Available balance cannot fund an order.",
        );
      }
    });
  return (
    <aside
      id="trade-ticket"
      className="panel p-5"
      aria-label="Trade conditional stock"
    >
      <div className="mb-5 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Trade conditional stock</h2>
        <span className="text-xs text-muted-foreground">Self-custodied</span>
      </div>
      <fieldset disabled={t.busy} className="min-w-0 space-y-4">
        <Segmented
          label="Order side"
          value={t.side === "buy" ? "Buy" : "Sell"}
          options={["Buy", "Sell"]}
          className="w-full"
          onChange={(value) =>
            edit(() => {
              const side = value === "Buy" ? "buy" : "sell";
              t.setSide(side);
              t.setPrice(priceFor(t.branch, side));
              setEntry("Quantity");
            })
          }
        />
        <div className="grid grid-cols-2 gap-2">
          {(["YES", "NO"] as const).map((branch) => (
            <Button
              key={branch}
              variant="ghost"
              className={`h-auto flex-col items-start gap-1 rounded-lg border px-3 py-3 text-left ${t.branch === branch ? (branch === "YES" ? "border-positive bg-positive-soft text-positive hover:bg-positive-soft" : "border-danger bg-danger-soft text-danger hover:bg-danger-soft") : "border-border bg-secondary text-muted-foreground"}`}
              aria-pressed={t.branch === branch}
              onClick={() =>
                edit(() => {
                  t.setBranch(branch);
                  t.setPrice(priceFor(branch, t.side));
                  setEntry("Quantity");
                })
              }
            >
              <span className="eyebrow">IF {branch}</span>
              <strong>
                {market.ticker}-{branch}
              </strong>
              <span className="font-mono text-xs">
                {formatNumber(
                  (branch === "YES" ? market.yes : market.no).bestAsk,
                )}
              </span>
            </Button>
          ))}
        </div>
        {!prepared ? (
          <>
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>
                Available{" "}
                {available === null || balanceError
                  ? "—"
                  : formatTokenAmount(
                      BigInt(available),
                      t.side === "buy"
                        ? market.quoteTokenDecimals
                        : market.baseTokenDecimals,
                    )}{" "}
                {t.side === "buy" ? "USDG" : market.ticker}
                {t.funding === "claim" ? `-${t.branch}` : ""}
              </span>
              <Button
                size="sm"
                variant="link"
                disabled={available === null || balanceError}
                onClick={maxQuantity}
              >
                Max
              </Button>
            </div>
            <div>
              <Label htmlFor="ticket-quantity" className="eyebrow">
                {entry === "Spend" && t.side === "buy" ? "Spend" : "Quantity"}
              </Label>
              <div className="mt-2 flex items-center rounded-lg border bg-background pr-3">
                <Input
                  id="ticket-quantity"
                  aria-label={
                    entry === "Spend" && t.side === "buy" ? "Spend" : "Quantity"
                  }
                  className="h-12 border-0 bg-transparent font-mono text-lg shadow-none"
                  inputMode="decimal"
                  value={
                    entry === "Spend" && t.side === "buy" ? spend : t.quantity
                  }
                  onChange={(event) =>
                    edit(() => {
                      if (entry === "Spend" && t.side === "buy") {
                        setSpend(event.target.value);
                        try {
                          t.setQuantity(
                            quantityForSpend(
                              event.target.value,
                              t.price,
                              market,
                            ),
                          );
                        } catch (error) {
                          t.setQuantity("");
                          setEntryError(
                            error instanceof Error
                              ? error.message
                              : "Invalid amount",
                          );
                        }
                      } else t.setQuantity(event.target.value);
                    })
                  }
                />
                <span className="text-xs font-medium text-muted-foreground">
                  {entry === "Spend" && t.side === "buy"
                    ? "USDG"
                    : market.ticker}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="ticket-price" className="eyebrow">
                {kind === "Market" ? "Worst price · 1% bound" : "Limit price"}
              </Label>
              <Segmented
                label="Order type"
                value={kind}
                options={["Limit", "Market"]}
                onChange={(value) =>
                  edit(() => {
                    setKind(value);
                    t.setTif(value === "Market" ? "ioc" : "gtc");
                    t.setPrice(priceFor(t.branch, t.side, value));
                    setEntry("Quantity");
                  })
                }
              />
            </div>
            <div className="flex items-center rounded-lg border bg-background pr-3">
              <Input
                id="ticket-price"
                aria-label={kind === "Market" ? "Worst price" : "Limit price"}
                inputMode="decimal"
                readOnly={kind === "Market"}
                value={t.price}
                className="h-12 border-0 bg-transparent font-mono text-lg shadow-none"
                onChange={(event) =>
                  edit(() => {
                    t.setPrice(event.target.value);
                    if (entry === "Spend") {
                      try {
                        t.setQuantity(
                          quantityForSpend(spend, event.target.value, market),
                        );
                      } catch {
                        t.setQuantity("");
                      }
                    }
                  })
                }
              />
              <span className="text-xs text-muted-foreground">USDG</span>
            </div>
            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Advanced order controls
              </summary>
              <div className="mt-4 space-y-4">
                {t.side === "buy" && (
                  <Segmented
                    label="Amount entry"
                    value={entry}
                    options={["Spend", "Quantity"]}
                    onChange={(value) =>
                      edit(() => {
                        setEntry(value);
                        if (value === "Spend") {
                          setSpend("");
                          t.setQuantity("");
                        }
                      })
                    }
                  />
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="ticket-tif">Time in force</Label>
                    <Select
                      disabled={kind === "Market"}
                      value={t.tif}
                      onValueChange={(value) => {
                        if (value === "gtc" || value === "ioc")
                          edit(() => t.setTif(value));
                      }}
                    >
                      <SelectTrigger id="ticket-tif" className="mt-2 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gtc">GTC · rests</SelectItem>
                        <SelectItem value="ioc">IOC · fill now</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="ticket-funding">Funding</Label>
                    <Select
                      value={t.funding}
                      onValueChange={(value) => {
                        if (value === "whole" || value === "claim")
                          edit(() => t.setFunding(value));
                      }}
                    >
                      <SelectTrigger
                        id="ticket-funding"
                        className="mt-2 w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="whole">Whole token</SelectItem>
                        <SelectItem value="claim">Active claim</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {
                  <div>
                    <Label htmlFor="max-fee-bps">
                      Maximum trading fee (bps)
                    </Label>
                    <Input
                      id="max-fee-bps"
                      type="number"
                      min="0"
                      max="1000"
                      step="1"
                      value={t.maxFeeBps}
                      onChange={(e) =>
                        edit(() => t.setMaxFeeBps(e.target.value))
                      }
                    />
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      100 bps = 1%. Fees come from received active claims. A
                      fill above your signed cap reverts; inactive claims are
                      unaffected.
                    </p>
                  </div>
                }
                <p className="text-xs text-muted-foreground">
                  Quantity step:{" "}
                  {formatTokenAmount(
                    BigInt(market.baseStep),
                    market.baseTokenDecimals,
                  )}{" "}
                  {market.ticker}. IOC releases any unfilled remainder.
                </p>
              </div>
            </details>
            {entryError && (
              <p role="alert" className="text-sm text-danger">
                {entryError}
              </p>
            )}
            {!t.readiness.ready && (
              <p role="status" className="text-sm text-warning">
                {t.readiness.reason}
              </p>
            )}
            <Button
              variant="brand"
              className="w-full text-sm"
              size="lg"
              disabled={
                t.busy ||
                (Boolean(t.wallet.account) &&
                  (!t.preview.valid ||
                    !t.readiness.ready ||
                    market.lifecycle !== "open"))
              }
              onClick={() =>
                t.wallet.account
                  ? t.prepare()
                  : t.wallet.connect().catch(() => undefined)
              }
            >
              {t.busy && <LoaderCircle className="animate-spin" />}
              {t.wallet.account ? "Review Order" : "Connect wallet"}
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <strong>Review order</strong>
              <Button
                variant="link"
                size="sm"
                onClick={() => t.setPreparation(null)}
              >
                Edit order
              </Button>
            </div>
            <div className="space-y-3 rounded-lg border p-3">
              <Row
                label="Order"
                value={`${t.side} ${quantityLabel} ${market.ticker}-${t.branch}`}
              />
              <Row
                label="Price · TIF"
                value={`${t.price} · ${t.tif.toUpperCase()}`}
              />
              <Row
                label="Funding"
                value={t.funding === "whole" ? "Whole token" : "Active claim"}
              />
              {prepared.plan && (
                <>
                  <Row
                    label="Fill now"
                    value={`${formatTokenAmount(BigInt(prepared.plan.filledQuantity), market.baseTokenDecimals)} ${market.ticker}`}
                  />
                  <Row
                    label={t.tif === "gtc" ? "Rests" : "Released"}
                    value={`${formatTokenAmount(BigInt(prepared.plan.remainingQuantity), market.baseTokenDecimals)} ${market.ticker}`}
                  />
                  <Row
                    label="Execution before fees"
                    value={`${formatTokenAmount(BigInt(prepared.plan.executionQuote), market.quoteTokenDecimals)} USDG`}
                  />
                  <Row
                    label="Maker / taker fee"
                    value={`${prepared.plan.guard.makerFeeBps} / ${prepared.plan.guard.takerFeeBps} bps`}
                  />
                </>
              )}
            </div>
            {!prepared.funding.balanceSufficient && (
              <p role="alert" className="text-sm text-danger">
                Insufficient canonical funding for this reservation.
              </p>
            )}
            {BigInt(prepared.funding.transferFee ?? "0") > 0n && (
              <p className="text-sm text-warning">
                Issuer transfer fee: {prepared.funding.transferFee} raw
                funding-token units. Your wallet deposit is{" "}
                {prepared.funding.depositAmount} raw units, including this fee.
                Vault credit excludes the fee; withdrawal may incur another
                issuer fee.
              </p>
            )}
            {t.quoteExpired && (
              <p role="alert" className="text-sm text-warning">
                Quote expired. Refresh before signing.
              </p>
            )}
            {prepared.plan && (
              <>
                <p className="text-xs leading-5 text-muted-foreground">
                  All reviewed fills execute together or revert. You pay gas,
                  including for a reverted transaction. Received assets and
                  refunds are credited to you and can be withdrawn from
                  Portfolio.
                </p>
                <Button variant="outline" size="sm" onClick={t.prepare}>
                  Refresh quote
                </Button>
              </>
            )}
            <Button
              className="w-full"
              variant="brand"
              size="lg"
              onClick={prepared.funding.approvalCall ? t.approve : t.submit}
              disabled={
                t.busy ||
                !prepared.funding.balanceSufficient ||
                (!prepared.funding.approvalCall && Boolean(t.quoteExpired))
              }
            >
              {t.busy && <LoaderCircle className="animate-spin" />}
              {prepared.funding.approvalCall
                ? "Fund order vault"
                : "Sign and place atomically"}
            </Button>
          </>
        )}
      </fieldset>
      <div className="mt-5 space-y-3 border-t pt-4">
        <Row
          label="Full fill at limit · before fees"
          value={
            t.side === "buy"
              ? `${quantityLabel} ${market.ticker}-${t.branch}`
              : `${formatUsd(t.preview.cost)} Cash-${t.branch}`
          }
        />
        <Row
          label="Maximum reservation"
          value={
            t.side === "buy"
              ? formatUsd(t.preview.cost)
              : `${quantityLabel} ${market.ticker}`
          }
        />
        <div className="grid grid-cols-2 gap-2 text-xs leading-5">
          <div className="rounded-lg border border-positive/30 bg-positive-soft p-3">
            <b className="text-positive">IF YES</b>
            <p>{outcome(t.branch === "YES")}</p>
          </div>
          <div className="rounded-lg border border-danger/30 bg-danger-soft p-3">
            <b className="text-danger">IF NO</b>
            <p>{outcome(t.branch === "NO")}</p>
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Outcomes illustrate a full fill at your limit before fees. Partial
          fills, price improvement and released IOC quantities change the actual
          claims received.
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          One user transaction places and matches your order. Exact vault
          funding, if needed, is separate. Balances update after indexing.
        </p>
      </div>
    </aside>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs font-medium">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono">{value}</span>
    </div>
  );
}
