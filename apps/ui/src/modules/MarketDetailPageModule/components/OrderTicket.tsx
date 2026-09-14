"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { useEffect, useState } from "react";
import { useUiStore } from "@/components/providers/UiStateProvider";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldSet, FieldLabel as Label } from "@/components/ui/field";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Item, ItemContent } from "@/components/ui/item";
import { Segmented } from "@/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOrderTicket } from "@/hooks/useOrderTicket";
import { usePositions } from "@/hooks/useProtocolData";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { formatNumber, formatUsd } from "@/lib/format/display";
import { marketPriceBound, quantityForSpend } from "@/lib/trading/entry";
import type { MarketView } from "@/types/api";

export function OrderTicket({ market }: { market: MarketView }) {
  const t = useOrderTicket({ market });
  const quantityLabel = formatTokenAmount(BigInt(t.preview.quantityRaw), market.baseTokenDecimals);
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
    t.setPrice((prefill.branch === "YES" ? market.yes : market.no).bestBidExact ?? "");
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
  const priceFor = (branch: "YES" | "NO", side: "buy" | "sell", orderKind = kind) => {
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
  const balanceError = t.funding === "whole" ? !assets.isDataFresh : !positions.isDataFresh;
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
                (BigInt(available) / BigInt(market.baseStep)) * BigInt(market.baseStep),
                market.baseTokenDecimals,
              );
        setEntry("Quantity");
        t.setQuantity(value);
      } catch (error) {
        setEntryError(
          error instanceof Error ? error.message : "Available balance cannot fund an order.",
        );
      }
    });
  return (
    <Card id="trade-ticket" aria-label="Trade conditional stock">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Trade conditional stock
        </CardTitle>
        <CardDescription>Self-custodied</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldSet disabled={t.busy} className="min-w-0 flex flex-col gap-4">
          <FieldGroup>
            <Segmented
              disabled={t.busy}
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
            <ToggleGroup
              aria-label="Conditional branch"
              value={[t.branch]}
              variant="outline"
              disabled={t.busy}
              className="grid w-full grid-cols-2"
              onValueChange={(values) => {
                const branch = values[0];
                if (branch !== "YES" && branch !== "NO") return;
                edit(() => {
                  t.setBranch(branch);
                  t.setPrice(priceFor(branch, t.side));
                  setEntry("Quantity");
                });
              }}
            >
              {(["YES", "NO"] as const).map((branch) => (
                <ToggleGroupItem
                  key={branch}
                  value={branch}
                  className="h-auto flex-col items-start gap-1 px-3 py-3"
                >
                  <span className="eyebrow">IF {branch}</span>
                  <strong>
                    {market.ticker}-{branch}
                  </strong>
                  <span className="font-mono text-xs">
                    {formatNumber((branch === "YES" ? market.yes : market.no).bestAsk)}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {!prepared ? (
              <>
                <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <InfoTooltip
                    content={
                      balanceError && available !== null
                        ? "Last-known balance; refreshing before it can be used."
                        : undefined
                    }
                  >
                    <span>
                      Available{" "}
                      {available === null
                        ? "—"
                        : formatTokenAmount(
                            BigInt(available),
                            t.side === "buy" ? market.quoteTokenDecimals : market.baseTokenDecimals,
                          )}{" "}
                      {t.side === "buy" ? "USDC" : market.ticker}
                      {t.funding === "claim" ? `-${t.branch}` : ""}
                    </span>
                  </InfoTooltip>
                  <Button
                    size="sm"
                    variant="link"
                    disabled={available === null || balanceError}
                    onClick={maxQuantity}
                  >
                    Max
                  </Button>
                </div>
                <Field data-invalid={Boolean(entryError)}>
                  <Label htmlFor="ticket-quantity">
                    {entry === "Spend" && t.side === "buy" ? "Spend" : "Quantity"}
                  </Label>
                  <InputGroup>
                    <InputGroupInput
                      id="ticket-quantity"
                      aria-invalid={Boolean(entryError)}
                      aria-label={entry === "Spend" && t.side === "buy" ? "Spend" : "Quantity"}
                      inputMode="decimal"
                      value={entry === "Spend" && t.side === "buy" ? spend : t.quantity}
                      onChange={(event) =>
                        edit(() => {
                          if (entry === "Spend" && t.side === "buy") {
                            setSpend(event.target.value);
                            try {
                              t.setQuantity(quantityForSpend(event.target.value, t.price, market));
                            } catch (error) {
                              t.setQuantity("");
                              setEntryError(
                                error instanceof Error ? error.message : "Invalid amount",
                              );
                            }
                          } else t.setQuantity(event.target.value);
                        })
                      }
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>
                        {entry === "Spend" && t.side === "buy" ? "USDC" : market.ticker}
                      </InputGroupText>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
                <Field>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="ticket-price">
                      {kind === "Market" ? "Worst price · 1% bound" : "Limit price"}
                    </Label>
                    <Segmented
                      disabled={t.busy}
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
                  <InputGroup>
                    <InputGroupInput
                      id="ticket-price"
                      aria-label={kind === "Market" ? "Worst price" : "Limit price"}
                      inputMode="decimal"
                      readOnly={kind === "Market"}
                      value={t.price}
                      onChange={(event) =>
                        edit(() => {
                          t.setPrice(event.target.value);
                          if (entry === "Spend") {
                            try {
                              t.setQuantity(quantityForSpend(spend, event.target.value, market));
                            } catch {
                              t.setQuantity("");
                            }
                          }
                        })
                      }
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>USDC</InputGroupText>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
                <Accordion>
                  <AccordionItem value="details">
                    <AccordionTrigger>Advanced order controls</AccordionTrigger>
                    <AccordionContent>
                      <div className="mt-4 flex flex-col gap-4">
                        {t.side === "buy" && (
                          <Segmented
                            disabled={t.busy}
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
                          <Field>
                            <Label htmlFor="ticket-tif">Time in force</Label>
                            <Select
                              disabled={t.busy || kind === "Market"}
                              value={t.tif}
                              items={{ gtc: "GTC · rests", ioc: "IOC · fill now" }}
                              onValueChange={(value) => {
                                if (value === "gtc" || value === "ioc") edit(() => t.setTif(value));
                              }}
                            >
                              <SelectTrigger id="ticket-tif" className="mt-2 w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="gtc">GTC · rests</SelectItem>
                                  <SelectItem value="ioc">IOC · fill now</SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field>
                            <Label htmlFor="ticket-funding">Funding</Label>
                            <Select
                              disabled={t.busy}
                              value={t.funding}
                              items={{ whole: "Whole token", claim: "Active claim" }}
                              onValueChange={(value) => {
                                if (value === "whole" || value === "claim")
                                  edit(() => t.setFunding(value));
                              }}
                            >
                              <SelectTrigger id="ticket-funding" className="mt-2 w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="whole">Whole token</SelectItem>
                                  <SelectItem value="claim">Active claim</SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                        </div>
                        {
                          <Field>
                            <Label htmlFor="max-fee-bps">Maximum trading fee (bps)</Label>
                            <Input
                              id="max-fee-bps"
                              type="number"
                              min="0"
                              max="1000"
                              step="1"
                              value={t.maxFeeBps}
                              onChange={(e) => edit(() => t.setMaxFeeBps(e.target.value))}
                            />
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">
                              100 bps = 1%. Fees come from received active claims. A fill above your
                              signed cap reverts; inactive claims are unaffected.
                            </p>
                          </Field>
                        }
                        <p className="text-xs text-muted-foreground">
                          Quantity step:{" "}
                          {formatTokenAmount(BigInt(market.baseStep), market.baseTokenDecimals)}{" "}
                          {market.ticker}. IOC releases any unfilled remainder.
                        </p>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
                {entryError && (
                  <Alert variant="destructive">
                    <AlertDescription>{entryError}</AlertDescription>
                  </Alert>
                )}
                <p role="status" className="min-h-5 text-xs text-muted-foreground">
                  {!t.readiness.ready ? t.readiness.reason : null}
                </p>
                <Button
                  variant="default"
                  className="w-full text-sm"
                  size="lg"
                  disabled={
                    t.busy ||
                    (Boolean(t.wallet.account) &&
                      (!t.preview.valid || !t.readiness.ready || market.lifecycle !== "open"))
                  }
                  onClick={() =>
                    t.wallet.account ? t.prepare() : t.wallet.connect().catch(() => undefined)
                  }
                >
                  {t.busy && <Spinner data-icon="inline-start" />}
                  {t.wallet.account ? "Review Order" : "Connect wallet"}
                </Button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <strong>Review order</strong>
                  <Button variant="link" size="sm" onClick={() => t.setPreparation(null)}>
                    Edit order
                  </Button>
                </div>
                <Item variant="outline">
                  <ItemContent>
                    <Row
                      label="Order"
                      value={`${t.side} ${quantityLabel} ${market.ticker}-${t.branch}`}
                    />
                    <Row label="Price · TIF" value={`${t.price} · ${t.tif.toUpperCase()}`} />
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
                          value={`${formatTokenAmount(BigInt(prepared.plan.executionQuote), market.quoteTokenDecimals)} USDC`}
                        />
                        <Row
                          label="Maker / taker fee"
                          value={`${prepared.plan.guard.makerFeeBps} / ${prepared.plan.guard.takerFeeBps} bps`}
                        />
                      </>
                    )}
                  </ItemContent>
                </Item>
                {!prepared.funding.balanceSufficient && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Insufficient canonical funding for this reservation.
                    </AlertDescription>
                  </Alert>
                )}
                {BigInt(prepared.funding.transferFee ?? "0") > 0n && (
                  <p className="text-sm text-warning">
                    Issuer transfer fee: {prepared.funding.transferFee} raw funding-token units.
                    Your wallet deposit is {prepared.funding.depositAmount} raw units, including
                    this fee. Vault credit excludes the fee; withdrawal may incur another issuer
                    fee.
                  </p>
                )}
                {t.quoteExpired && (
                  <Alert>
                    <AlertDescription>Quote expired. Refresh before signing.</AlertDescription>
                  </Alert>
                )}
                {prepared.plan && (
                  <>
                    <p className="text-xs leading-5 text-muted-foreground">
                      All reviewed fills execute together or revert. You pay gas, including for a
                      reverted transaction. Received assets and refunds are credited to you and can
                      be withdrawn from Portfolio.
                    </p>
                    <Button variant="outline" size="sm" onClick={t.prepare}>
                      Refresh quote
                    </Button>
                  </>
                )}
                <Button
                  className="w-full"
                  variant="default"
                  size="lg"
                  onClick={prepared.funding.approvalCall ? t.approve : t.submit}
                  disabled={
                    t.busy ||
                    !t.readiness.ready ||
                    !prepared.funding.balanceSufficient ||
                    (!prepared.funding.approvalCall && Boolean(t.quoteExpired))
                  }
                >
                  {t.busy && <Spinner data-icon="inline-start" />}
                  {prepared.funding.approvalCall ? "Fund order vault" : "Sign and place atomically"}
                </Button>
              </>
            )}
          </FieldGroup>
        </FieldSet>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
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
          value={t.side === "buy" ? formatUsd(t.preview.cost) : `${quantityLabel} ${market.ticker}`}
        />
        <div className="grid grid-cols-2 gap-2 text-xs leading-5">
          <Item variant="outline">
            <ItemContent>
              <Badge variant="positive">IF YES</Badge>
              <p>{outcome(t.branch === "YES")}</p>
            </ItemContent>
          </Item>
          <Item variant="outline">
            <ItemContent>
              <Badge variant="destructive">IF NO</Badge>
              <p>{outcome(t.branch === "NO")}</p>
            </ItemContent>
          </Item>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Outcomes illustrate a full fill at your limit before fees. Partial fills, price
          improvement and released IOC quantities change the actual claims received.
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          One user transaction places and matches your order. Exact vault funding, if needed, is
          separate. Balances update after indexing.
        </p>
      </CardFooter>
    </Card>
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
