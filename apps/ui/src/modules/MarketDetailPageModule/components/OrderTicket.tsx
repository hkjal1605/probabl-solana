"use client";

import { formatShareAmount, formatTokenAmount } from "@conditional-stocks/domain";
import {
  claimAsset as claimAssetOf,
  legBit,
  underlyingAsset,
} from "@conditional-stocks/solana-client";
import { Repeat2Icon, WalletIcon } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLegend,
  FieldSet,
  FieldLabel as Label,
} from "@/components/ui/field";
import { InfoTooltip } from "@/components/ui/info-tooltip";
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
import { useWalletLogin } from "@/components/wallet/WalletLoginProvider";
import { useOrderTicket } from "@/hooks/useOrderTicket";
import { usePositions } from "@/hooks/useProtocolData";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { formatCompactNumber, formatNumber, formatUsd } from "@/lib/format/display";
import { assetMint, maskLabel, sharesForRaw } from "@/lib/markets/legs";
import { bestPriceFor, marketPriceBound, quantityForSpend } from "@/lib/trading/entry";
import type { MarketView } from "@/types/api";

export function OrderTicket({ market }: { market: MarketView }) {
  const router = useRouter();
  const t = useOrderTicket({ market });
  const login = useWalletLogin();
  const quantityLabel = formatShareAmount(BigInt(t.preview.quantityRaw), market);
  const prefill = useUiStore((s) => s.prefill);
  const setPrefill = useUiStore((s) => s.setPrefill);
  const assets = useWalletAssets([market]),
    positions = usePositions();
  const [kind, setKind] = useState<"Limit" | "Market">("Market");
  const [entry, setEntry] = useState<"Quantity" | "Spend">("Quantity");
  const [spend, setSpend] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  // A close-position intent is data only: it never signs or submits automatically.
  useEffect(() => {
    if (!prefill || prefill.marketId !== market.id) return;
    t.setBranch(prefill.branch);
    t.setSide("sell");
    t.setFunding("claim");
    t.setSellLeg(prefill.collateral ?? null);
    t.setQuantity(prefill.quantity);
    t.setPrice(
      bestPriceFor(
        market,
        prefill.branch,
        "sell",
        prefill.collateral ? legBit(prefill.collateral) : null,
      ) ?? "",
    );
    t.setTif("gtc");
    t.setPreparation(null);
    setEntry("Quantity");
    setKind("Limit");
    setPrefill(null);
  }, [
    prefill,
    market,
    t.setBranch,
    t.setSide,
    t.setFunding,
    t.setSellLeg,
    t.setQuantity,
    t.setPrice,
    t.setTif,
    t.setPreparation,
    setPrefill,
  ]);
  useEffect(() => {
    if (t.submissionCount === 0) return;
    setKind("Market");
    setEntry("Quantity");
    setSpend("");
    setEntryError(null);
  }, [t.submissionCount]);
  const edit = (action: () => void) => {
    setEntryError(null);
    action();
  };
  // Best prices follow the selected issuer set: a buy only takes asks of accepted
  // issuers; a sell only hits bids that accept the delivered issuer.
  const maskFor = (side: "buy" | "sell", sellLeg = t.sellLeg, accepted = t.acceptedMask) =>
    side === "buy" ? accepted : sellLeg ? legBit(sellLeg) : 0;
  const priceFor = (
    branch: "YES" | "NO",
    side: "buy" | "sell",
    orderKind = kind,
    mask = maskFor(side),
  ) => {
    try {
      return orderKind === "Market"
        ? marketPriceBound(market, branch, side, 100, mask)
        : (bestPriceFor(market, branch, side, mask) ?? "");
    } catch {
      return "";
    }
  };
  const bestFor = (branch: "YES" | "NO") => {
    const exact = bestPriceFor(market, branch, t.side, maskFor(t.side));
    return exact === null ? null : Number(exact);
  };
  const sellLeg = t.sellStatus?.leg ?? null;
  const unitSymbol = t.side === "sell" && sellLeg ? sellLeg.symbol : market.ticker;
  const outcome = (wins: boolean) =>
    t.side === "buy"
      ? wins
        ? `${quantityLabel} ${market.ticker} (${maskLabel(market, t.acceptedMask)} claim)`
        : t.funding === "whole"
          ? `${formatUsd(t.preview.cost)} cash claim`
          : "No payout (active claim only)"
      : wins
        ? `${formatUsd(t.preview.cost)} cash claim`
        : t.funding === "whole"
          ? `${t.reservation ? `${t.reservation.formatted} ${t.reservation.symbol}` : `${quantityLabel} ${unitSymbol}`} claim`
          : "No payout (active claim only)";
  const prepared = t.preparation;
  const branchIndex = t.branch === "YES" ? 0 : 1;
  // Funding asset: quote pool credit or quote claim for buys; the delivered
  // issuer's pool credit (asset 3c) or its own claim for sells.
  const fundingMint =
    t.side === "buy"
      ? t.funding === "whole"
        ? market.quoteToken
        : assetMint(market, claimAssetOf(0, branchIndex))
      : sellLeg
        ? assetMint(
            market,
            t.funding === "whole"
              ? underlyingAsset(sellLeg.collateral)
              : claimAssetOf(sellLeg.collateral, branchIndex),
          )
        : null;
  const claim =
    positions.data?.owner === t.wallet.account && fundingMint
      ? (positions.data.balances[fundingMint]?.creditBalances?.[market.id] ?? "0")
      : null;
  const wholeBalance = assets.balances.find((a) => a.token === fundingMint)?.balance;
  const available =
    t.funding === "whole" ? (fundingMint ? (wholeBalance?.vaultAvailable ?? null) : null) : claim;
  const availableDecimals =
    t.side === "buy" ? market.quoteTokenDecimals : (sellLeg?.decimals ?? market.shareDecimals);
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
            : (() => {
                if (!t.sellStatus) throw new Error("Choose an issuer token to sell.");
                const shares = sharesForRaw(
                  BigInt(available),
                  t.sellStatus,
                  BigInt(market.baseStep),
                );
                if (shares <= 0n) throw new Error("Available balance is below one order step.");
                return formatShareAmount(shares, market);
              })();
        setEntry("Quantity");
        t.setQuantity(value);
      } catch (error) {
        setEntryError(
          error instanceof Error ? error.message : "Available balance cannot fund an order.",
        );
      }
    });
  const selectAccepted = (collateral: number, accepted: boolean) =>
    edit(() => {
      t.toggleAcceptedLeg(collateral, accepted);
      if (kind === "Market") {
        const current = t.acceptedLegs ?? t.legs.filter((l) => l.tradable).map((l) => l.collateral);
        const next = accepted
          ? [...current, collateral]
          : current.filter((value) => value !== collateral);
        const mask = t.legs.reduce(
          (all, l) => (l.tradable && next.includes(l.collateral) ? all | l.bit : all),
          0,
        );
        t.setPrice(priceFor(t.branch, "buy", kind, mask));
      }
    });
  const selectSellLeg = (collateral: number) =>
    edit(() => {
      t.setSellLeg(collateral);
      t.setPrice(priceFor(t.branch, "sell", kind, legBit(collateral)));
      setEntry("Quantity");
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
                  <span className="tabular-nums text-xs">{formatNumber(bestFor(branch))}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {market.bases.length > 0 && (
              <IssuerSelector
                market={market}
                ticket={t}
                disabled={t.busy}
                onAccept={selectAccepted}
                onSell={selectSellLeg}
              />
            )}
            {
              <>
                <div className="trade-entry-section">
                  <div className="trade-entry-heading">
                    <Label htmlFor="ticket-quantity">
                      {t.side === "buy" ? "Buy" : "Sell"}
                      <Avatar className="trade-entry-token-icon">
                        <AvatarImage
                          src={(sellLeg?.metadata ?? market.assetMetadata)?.image}
                          alt=""
                        />
                        <AvatarFallback>{market.ticker.slice(0, 1)}</AvatarFallback>
                      </Avatar>
                      {market.ticker}
                    </Label>
                    <div className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
                      <WalletIcon className="size-3.5" aria-hidden="true" />
                      <InfoTooltip
                        content={
                          balanceError && available !== null ? "Last-known balance." : undefined
                        }
                      >
                        <span className="text-sm font-medium">
                          {available === null
                            ? "—"
                            : formatCompactNumber(
                                Number(formatTokenAmount(BigInt(available), availableDecimals)),
                              )}{" "}
                          {t.side === "buy" ? "USDC" : unitSymbol}
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
                      {t.legError && (
                        <p role="status" className="text-xs leading-4 text-warning">
                          {t.legError}
                        </p>
                      )}
                      {!t.readiness.ready && (
                        <p role="status" className="text-xs leading-4 font-medium text-muted-foreground">
                          {t.readiness.reason}
                        </p>
                      )}
                      <Button
                        variant={t.side === "buy" ? "buy" : "sell"}
                        className="trade-entry-submit w-full"
                        size="lg"
                        disabled={
                          t.busy ||
                          Boolean(t.wallet.account && !t.permissionLoaded) ||
                          Boolean(
                            t.wallet.account &&
                              t.permission?.active &&
                              (!prepared ||
                                t.reviewing ||
                                t.quoteExpired ||
                                !t.preview.valid ||
                                Boolean(t.legError) ||
                                !t.readiness.ready ||
                                market.lifecycle !== "open"),
                          )
                        }
                        onClick={() =>
                          !t.wallet.account
                            ? login()
                            : !t.permission?.active
                              ? t.enableTrading()
                              : prepared && !prepared.funding.balanceSufficient
                                ? router.push("/portfolio")
                                : t.submit()
                        }
                      >
                        {t.busy || t.reviewing || (t.wallet.account && !t.permissionLoaded) ? (
                          <Spinner />
                        ) : !t.wallet.account ? (
                          "Connect wallet"
                        ) : !t.permission?.active ? (
                          "Enable trading"
                        ) : prepared && !prepared.funding.balanceSufficient ? (
                          "Deposit in Portfolio"
                        ) : (
                          "Place order"
                        )}
                      </Button>
                      {t.reviewError && (
                        <div
                          role="status"
                          className="flex flex-col gap-1 text-xs font-medium text-muted-foreground"
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
                <Accordion className="-mt-1">
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
                  <Row
                    label={t.side === "buy" ? "Accepts" : "Delivers"}
                    value={maskLabel(market, prepared.order.bases)}
                  />
                  <Separator />
                  <Row label="Price · TIF" value={`${t.price} · ${t.tif.toUpperCase()}`} />
                  <Row
                    label="Funding"
                    value={t.funding === "whole" ? "Whole token" : "Active claim"}
                  />
                  <Row
                    label="Reserves"
                    value={`${formatTokenAmount(BigInt(prepared.funding.amount), prepared.funding.decimals)} ${prepared.funding.symbol}${t.funding === "claim" ? `-${t.branch}` : ""}`}
                  />
                  {prepared.plan && (
                    <>
                      <Row
                        label="Fill now"
                        value={`${formatShareAmount(BigInt(prepared.plan.filledQuantity), market)} ${market.ticker}`}
                      />
                      <Row
                        label={t.tif === "gtc" ? "Rests" : "Released"}
                        value={`${formatShareAmount(BigInt(prepared.plan.remainingQuantity), market)} ${market.ticker}`}
                      />
                    </>
                  )}
                </section>
                {!prepared.funding.balanceSufficient && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Deposit the required amount in Portfolio before placing this order.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </FieldGroup>
        </FieldSet>
      </CardContent>
      <CardFooter className="-mt-1 flex-col items-stretch gap-3 border-t-0 pt-0">
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
const formatMultiplier = (value: number) =>
  Number.isFinite(value) ? value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "—";

type Ticket = ReturnType<typeof useOrderTicket>;

/**
 * Buy: which issuer tokens the bid accepts (default every tradable issuer).
 * Sell: exactly one issuer token to deliver. Halted issuers are shown disabled
 * with their reason; the live multiplier converts shares to raw token units.
 */
function IssuerSelector({
  market,
  ticket,
  disabled,
  onAccept,
  onSell,
}: {
  market: MarketView;
  ticket: Ticket;
  disabled: boolean;
  onAccept: (collateral: number, accepted: boolean) => void;
  onSell: (collateral: number) => void;
}) {
  const buying = ticket.side === "buy";
  return (
    <FieldSet
      className="min-w-0 gap-2"
      aria-label={buying ? "Accepted issuers" : "Issuer to deliver"}
    >
      <FieldLegend
        variant="label"
        className="flex w-full items-center justify-between text-xs data-[variant=label]:text-xs font-medium text-muted-foreground"
      >
        <span>{buying ? "Accept issuer tokens" : "Deliver issuer token"}</span>
        <span className="tabular-nums">
          {buying ? maskLabel(market, ticket.acceptedMask) : (ticket.sellStatus?.leg.symbol ?? "—")}
        </span>
      </FieldLegend>
      {buying ? (
        <div className="flex flex-col gap-1.5">
          {ticket.legs.map((status) => {
            const id = `ticket-issuer-${status.collateral}`;
            return (
              <InfoTooltip key={status.collateral} content={status.reason ?? undefined}>
                <label
                  htmlFor={id}
                  data-halted={!status.tradable || undefined}
                  className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-xs data-halted:text-muted-foreground"
                >
                  <Checkbox
                    id={id}
                    checked={status.tradable && (ticket.acceptedMask & status.bit) !== 0}
                    disabled={disabled || !status.tradable}
                    onCheckedChange={(checked) => onAccept(status.collateral, checked === true)}
                  />
                  <LegName status={status} />
                </label>
              </InfoTooltip>
            );
          })}
        </div>
      ) : (
        <ToggleGroup
          aria-label="Issuer token to deliver"
          value={ticket.sellLeg ? [String(ticket.sellLeg)] : []}
          variant="outline"
          spacing={1}
          disabled={disabled}
          className="grid w-full auto-cols-fr grid-flow-col"
          onValueChange={(values) => {
            const collateral = Number(values[0]);
            if (Number.isInteger(collateral) && collateral > 0) onSell(collateral);
          }}
        >
          {ticket.legs.map((status) => (
            <ToggleGroupItem
              key={status.collateral}
              value={String(status.collateral)}
              disabled={!status.tradable}
              title={status.reason ?? undefined}
              className="h-auto min-w-0 flex-col items-start gap-0.5 px-2 py-1.5"
            >
              <span className="truncate text-xs font-medium">{status.leg.symbol}</span>
              <span className="truncate text-[11px] tabular-nums font-medium text-muted-foreground">
                {status.tradable
                  ? `${formatCompactNumber(
                      Number(
                        formatTokenAmount(
                          ticket.holdings[status.collateral] ?? 0n,
                          status.leg.decimals,
                        ),
                      ),
                    )} held`
                  : "Halted"}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </FieldSet>
  );
}

function LegName({ status }: { status: Ticket["legs"][number] }) {
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{status.leg.symbol}</span>
        {status.leg.issuer && (
          <span className="ml-1 font-medium text-muted-foreground">{status.leg.issuer}</span>
        )}
      </span>
      {status.tradable ? (
        <span className="shrink-0 tabular-nums font-medium text-muted-foreground">
          ×{formatMultiplier(status.multiplierValue)}
        </span>
      ) : (
        <Badge variant="warning">Halted</Badge>
      )}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs font-medium">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}
