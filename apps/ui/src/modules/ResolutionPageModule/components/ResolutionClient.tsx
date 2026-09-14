"use client";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Item, ItemContent } from "@/components/ui/item";
import { DataError, EmptyState, LoadingState, Page, PageHeading, Stat } from "@/components/ui/page";
import { Progress } from "@/components/ui/progress";
import { protocolConfig } from "@/config/protocol";
import { useMarkets } from "@/hooks/useProtocolData";
import { useResource } from "@/hooks/useResource";
import { formatTime } from "@/lib/format/display";
import { outcomeLabel, safeExternalUrl } from "@/lib/markets/resolution";
import { cn } from "@/lib/utils";
import { MarketRules } from "@/modules/MarketDetailPageModule/components/MarketRules";
import { resolutionStore } from "@/stores/useResolutionStore";
import type { MarketView } from "@/types/api";
import { fetchResolution } from "../utils/fetchResolution";

const stages = ["open", "frozen", "awaiting-resolution", "resolved", "redeemable"];
const labels = ["OPEN", "FROZEN", "REVIEW", "RESOLVED", "REDEEMABLE"];
export function ResolutionClient({
  markets: initial,
  selected,
}: {
  markets: MarketView[];
  selected?: string | undefined;
}) {
  const query = useMarkets(initial),
    { markets } = query;
  return (
    <Page>
      <PageHeading
        title="Resolution"
        description={
          <>
            From open books to a settled outcome.
            <br />
            Public evidence, canonical payouts, and claim redemption.
          </>
        }
      >
        <div className="flex gap-6">
          <Stat label="open" value={markets.filter((m) => m.lifecycle === "open").length} />
          <Stat
            label="in review"
            value={markets.filter((m) => m.lifecycle === "awaiting-resolution").length}
          />
          <Stat
            label="redeemable"
            value={markets.filter((m) => m.lifecycle === "redeemable").length}
          />
        </div>
      </PageHeading>
      {query.isError && (
        <DataError
          retry={() => {
            void query.refetch();
          }}
        />
      )}
      <div className="flex flex-col gap-3">
        {markets.map((market) => (
          <ResolutionCard key={market.id} market={market} selected={selected === market.id} />
        ))}
      </div>
      {!markets.length && !query.isError && (
        <Card variant="panel">
          {query.isFetching ? (
            <LoadingState>Reading markets…</LoadingState>
          ) : (
            <EmptyState>No markets are indexed.</EmptyState>
          )}
        </Card>
      )}
    </Page>
  );
}
function ResolutionCard({ market, selected }: { market: MarketView; selected: boolean }) {
  const query = useResource(
    resolutionStore,
    market.id,
    (force) => fetchResolution(market.id, force),
    ["resolved", "redeemable", "archived"].includes(market.lifecycle),
  );
  const resolution = query.data ?? null;
  const index = market.lifecycle === "archived" ? 5 : stages.indexOf(market.lifecycle);
  const evidence = safeExternalUrl(resolution?.evidenceUri),
    explorer = safeExternalUrl(protocolConfig.explorerUrl);
  return (
    <Card id={market.id} className={cn("scroll-mt-20", selected && "ring-2 ring-primary")}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <strong className="tabular-nums text-xs">{market.ticker}</strong>
            <LifecycleBadge state={market.lifecycle} />
          </div>
          <span className="text-xs font-medium text-muted-foreground">
            Cutoff {formatTime(market.cutoff)}
          </span>
        </div>
        <CardTitle role="heading" aria-level={2}>
          {market.question}
        </CardTitle>
        <CardDescription>
          Applies to this market’s books and claims. Each local market resolves independently.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Progress
          value={Math.min(100, Math.max(0, index) * 25)}
          aria-label="Resolution lifecycle"
        />
        <ol className="grid grid-cols-5 gap-2" aria-label="Resolution lifecycle steps">
          {labels.map((label, i) => (
            <li
              key={label}
              aria-current={index === i ? "step" : undefined}
              className="flex min-w-0 flex-col items-center gap-2 text-center text-xs"
            >
              <Badge variant={i <= index ? "default" : "outline"}>{i + 1}</Badge>
              {label}
            </li>
          ))}
        </ol>
        <p className="text-sm font-medium leading-6 text-muted-foreground">
          {market.lifecycle === "open"
            ? "Both books are open. At cutoff, trading stops; expired or closed orders can release their escrow."
            : market.lifecycle === "scheduled"
              ? "Trading has not opened yet."
              : index < 3
                ? "Trading is closed. Market-admin evidence approval and an authorized onchain resolution are required."
                : `Final reference: ${outcomeLabel(resolution)}. Payouts follow the local contract’s finalized numerator and denominator.`}
        </p>
        {query.isError && (
          <DataError
            message="Resolution evidence is temporarily unavailable."
            retry={() => {
              void query.refetch();
            }}
          />
        )}
        {resolution?.payoutDenominator && (
          <Item variant="outline">
            <ItemContent>
              <span>
                YES payout{" "}
                <b className="tabular-nums">
                  {resolution.yesPayout}/{resolution.payoutDenominator}
                </b>
              </span>
              <span>
                NO payout{" "}
                <b className="tabular-nums">
                  {resolution.noPayout}/{resolution.payoutDenominator}
                </b>
              </span>
            </ItemContent>
          </Item>
        )}
        <Accordion>
          <AccordionItem value="details">
            <AccordionTrigger>Evidence &amp; exact terms</AccordionTrigger>
            <AccordionContent>
              <MarketRules market={market} />
              {resolution?.evidenceHash && (
                <p className="break-all font-mono text-xs">
                  Evidence hash: {resolution.evidenceHash}
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {evidence && (
                  <Button
                    size="sm"
                    variant="outline"
                    render={<a href={evidence} target="_blank" rel="noreferrer" />}
                    nativeButton={false}
                  >
                    Evidence <ArrowUpRight />
                  </Button>
                )}
                {explorer &&
                  resolution?.transactionHash &&
                  /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(resolution.transactionHash) && (
                    <Button
                      size="sm"
                      variant="outline"
                      render={
                        <a
                          href={`${explorer.replace(/\/$/, "")}/tx/${resolution.transactionHash}`}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                      nativeButton={false}
                    >
                      Admin transaction <ArrowUpRight />
                    </Button>
                  )}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-3">
        <Button
          variant="link"
          render={<Link href={`/markets/${market.id}`} />}
          nativeButton={false}
        >
          View market →
        </Button>
        {market.lifecycle === "redeemable" || market.lifecycle === "archived" ? (
          <Button variant="default" render={<Link href="/portfolio" />} nativeButton={false}>
            Redeem in portfolio
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
