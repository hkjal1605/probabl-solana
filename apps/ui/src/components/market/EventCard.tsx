import Link from "next/link";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber, formatTime } from "@/lib/format/display";
import { compact, impactPercent, marketCategory, midpoint } from "@/lib/markets/presentation";
import type { MarketView } from "@/types/api";
import { ImpactBar } from "./ImpactBar";
import { TokenIdentity } from "./TokenIdentity";

export function EventCard({ markets }: { markets: MarketView[] }) {
  const market = markets[0];
  if (!market) return null;
  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
        <Avatar size="lg">
          <AvatarFallback>
            {marketCategory(market) === "Macro"
              ? "FED"
              : marketCategory(market) === "Policy"
                ? "PRC"
                : market.ticker}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <CardTitle role="heading" aria-level={2}>
            <Link href={`/markets/${market.id}`}>{market.question}</Link>
          </CardTitle>
          <CardDescription className="mt-1 flex flex-wrap items-center gap-1">
            {marketCategory(market)} · Cutoff {formatTime(market.cutoff)} ·{" "}
            <LifecycleBadge state={market.lifecycle} />
          </CardDescription>
        </div>
        <div className="ml-auto text-right">
          <b className="font-mono text-xl font-medium">
            {market.probability.quality === "valid" && market.probability.value !== null
              ? `${formatNumber(market.probability.value * 100, 0)}%`
              : "—"}
          </b>
          <InfoTooltip content={`Source quality: ${market.probability.quality}`}>
            <p className="text-xs font-medium text-muted-foreground">P(YES) · Polymarket</p>
          </InfoTooltip>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Asset</TableHead>
              <TableHead>If YES</TableHead>
              <TableHead>Impact</TableHead>
              <TableHead>If NO</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {markets.map((asset) => (
              <TableRow key={asset.id}>
                <TableCell>
                  <Link href={`/markets/${asset.id}`}>
                    <TokenIdentity symbol={asset.ticker} metadata={asset.baseTokenMetadata} />
                  </Link>
                </TableCell>
                <TableCell className="font-mono">
                  <Link href={`/markets/${asset.id}`}>{formatNumber(midpoint(asset.yes))}</Link>
                </TableCell>
                <TableCell>
                  <Link href={`/markets/${asset.id}`}>
                    <ImpactBar value={impactPercent(asset)} />
                  </Link>
                </TableCell>
                <TableCell className="font-mono">
                  <Link href={`/markets/${asset.id}`}>{formatNumber(midpoint(asset.no))}</Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <span>
          {markets.length} {markets.length === 1 ? "market" : "markets"} ·{" "}
          {markets.some((m) => m.bookQuality && m.bookQuality !== "available")
            ? "depth unavailable"
            : `$${compact(markets.reduce((sum, asset) => sum + asset.yes.depthUsd + asset.no.depthUsd, 0))} visible depth`}
        </span>
        <Link href={`/markets/${market.id}`} className="font-semibold text-foreground">
          Trade →
        </Link>
      </CardFooter>
    </Card>
  );
}
