"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { Repeat2Icon, WalletIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useUiStore } from "@/components/providers/UiStateProvider";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
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
import { Separator } from "@/components/ui/separator";
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
    <Card variant="sidebar" id="trade-ticket" aria-label="Trade conditional stock" className="pt-0">
      <Segmented
        variant="trade"
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
      <CardContent>
        <FieldSet disabled={t.busy} className="min-w-0 flex flex-col gap-4">
          <FieldGroup>
            <ToggleGroup
              aria-label="Conditional branch"
              value={[t.branch]}
              variant="outline"
              spacing={2}
              disabled={t.busy}
              className="trade-branch-selector grid w-full grid-cols-2"
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
                  className="h-auto min-w-0 flex-col items-start gap-1 px-2 py-2"
                >
                  <span className="eyebrow">IF {branch}</span>
                  <span className="tabular-nums text-xs">
                    {formatNumber(
                      t.side === "buy"
                        ? (branch === "YES" ? market.yes : market.no).bestAsk
                        : (branch === "YES" ? market.yes : market.no).bestBid,
                    )}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {
              <>
                <div className="trade-entry-section">
                  <div className="trade-entry-heading">
                    <Label htmlFor="ticket-quantity">
                      {t.side === "buy" ? "Buy" : "Sell"}
                      <Avatar className="trade-entry-token-icon">
                        <AvatarImage src={market.baseTokenMetadata?.image} alt="" />
                        <AvatarFallback>{market.ticker.slice(0, 1)}</AvatarFallback>
                      </Avatar>
                      {market.ticker}
                    </Label>
                    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <WalletIcon className="size-3.5" aria-hidden="true" />
                      <InfoTooltip
                        content={
                          balanceError && available !== null ? "Last-known balance." : undefined
                        }
                      >
                        <span>
                          {available === null
                            ? "—"
                            : formatTokenAmount(
                                BigInt(available),
                                t.side === "buy"
                                  ? market.quoteTokenDecimals
                                  : market.baseTokenDecimals,
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
                  </div>
                  <Card className="trade-entry-card">
                    <CardContent>
                      <Field data-invalid={Boolean(entryError)} className="trade-entry-field">
                        <InputGroup className="trade-amount-input">
                          <InputGroupInput
                            id="ticket-quantity"
                            aria-invalid={Boolean(entryError)}
                            aria-label={
                              entry === "Spend" && t.side === "buy" ? "Spend" : "Quantity"
                            }
                            inputMode="decimal"
                            placeholder="0"
                            value={entry === "Spend" && t.side === "buy" ? spend : t.quantity}
                            onChange={(event) =>
                              edit(() => {
                                if (entry === "Spend" && t.side === "buy") {
                                  setSpend(event.target.value);
                                  try {
                                    t.setQuantity(
                                      quantityForSpend(event.target.value, t.price, market),
                                    );
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
                            {t.side === "buy" && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={
                                  entry === "Spend" ? "Enter token quantity" : "Enter USDC spend"
                                }
                                onClick={() =>
                                  edit(() => {
                                    setEntry(entry === "Spend" ? "Quantity" : "Spend");
                                    setSpend("");
                                    t.setQuantity("");
                                  })
                                }
                              >
                                <Repeat2Icon />
                              </Button>
                            )}
                          </InputGroupAddon>
                        </InputGroup>
                        <div className="trade-entry-estimate">
                          {t.preview.valid ? formatUsd(t.preview.cost) : "—"}
                          <span>Order value</span>
                        </div>
                      </Field>
                      <Field className="trade-entry-field">
                        <div className="trade-entry-heading">
                          <Label htmlFor="ticket-price">
                            {kind === "Market" ? "Worst price · 1% bound" : "Limit price"}
                          </Label>
                          <Segmented
                            variant="chart"
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
                        <InputGroup className="trade-amount-input">
                          <InputGroupInput
                            id="ticket-price"
                            aria-label={kind === "Market" ? "Worst price" : "Limit price"}
                            inputMode="decimal"
                            placeholder="0"
                            readOnly={kind === "Market"}
                            value={t.price}
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
                          <InputGroupAddon align="inline-end">
                            <InputGroupText>USDC</InputGroupText>
                          </InputGroupAddon>
                        </InputGroup>
                      </Field>
                      {entryError && (
                        <Alert variant="destructive">
                          <AlertDescription>{entryError}</AlertDescription>
                        </Alert>
                      )}
                      {!t.readiness.ready && (
                        <p role="status" className="text-xs leading-4 text-muted-foreground">
                          {t.readiness.reason}
                        </p>
                      )}
                      <Button
                        variant={t.side === "buy" ? "buy" : "sell"}
                        className="trade-entry-submit w-full"
                        size="lg"
                        disabled={
                          t.busy ||
                          (Boolean(t.wallet.account) &&
                            (!prepared ||
                              t.reviewing ||
                              t.quoteExpired ||
                              !prepared.funding.balanceSufficient ||
                              !t.preview.valid ||
                              !t.readiness.ready ||
                              market.lifecycle !== "open"))
                        }
                        onClick={() =>
                          !t.wallet.account
                            ? t.wallet.connect().catch(() => undefined)
                            : prepared?.funding.approvalCall
                              ? t.approve()
                              : t.submit()
                        }
                      >
                        {(t.busy || t.reviewing) && <Spinner data-icon="inline-start" />}
                        {!t.wallet.account
                          ? "Connect wallet"
                          : prepared?.funding.approvalCall
                            ? "Fund order vault"
                            : "Sign and place order"}
                      </Button>
                      {t.reviewError && (
                        <div
                          role="status"
                          className="flex flex-col gap-1 text-xs text-muted-foreground"
                        >
                          <span>{t.reviewError}</span>
                          <Button variant="link" size="sm" disabled={t.busy} onClick={t.prepare}>
                            Retry review / sign in
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
                <Accordion>
                  <AccordionItem value="details">
                    <AccordionTrigger>Advanced order controls</AccordionTrigger>
                    <AccordionContent>
                      <div className="flex flex-col gap-3">
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
                              <SelectTrigger id="ticket-tif" className="w-full">
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
                              <SelectTrigger id="ticket-funding" className="w-full">
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
              </>
            }
            {prepared && (
              <>
                <section className="trade-order-details" aria-label="Order details">
                  <Row
                    label="Order"
                    value={`${t.side} ${quantityLabel} ${market.ticker}-${t.branch}`}
                  />
                  <Separator />
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
                    </>
                  )}
                </section>
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
              </>
            )}
          </FieldGroup>
        </FieldSet>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3 border-t-0">
        <div className="grid grid-cols-2 gap-2 text-xs leading-5">
          <Item variant="outline" size="sm">
            <ItemContent>
              <Badge variant="positive">IF YES</Badge>
              <p>{outcome(t.branch === "YES")}</p>
            </ItemContent>
          </Item>
          <Item variant="outline" size="sm">
            <ItemContent>
              <Badge variant="destructive">IF NO</Badge>
              <p>{outcome(t.branch === "NO")}</p>
            </ItemContent>
          </Item>
        </div>
      </CardFooter>
    </Card>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs font-medium">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}
