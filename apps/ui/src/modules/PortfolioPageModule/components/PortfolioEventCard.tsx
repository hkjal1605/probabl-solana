"use client";

import Link from "next/link";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { ClaimTable } from "@/components/portfolio/ClaimTable";
import { PositionTable } from "@/components/portfolio/PositionTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineTabsList, LineTabsTrigger } from "@/components/ui/line-tabs";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/format/display";
import { OrdersClient } from "@/modules/OrdersPageModule/components/OrdersClient";
import type { IndexedOrder, MarketView, PositionView } from "@/types/api";

const hasClaims = (position: PositionView) =>
  [position.stockYes, position.stockNo, position.quoteYes, position.quoteNo].some(
    (amount) => BigInt(amount) > 0n,
  );

export function PortfolioEventCard({
  markets,
  orders,
  positions,
}: {
  markets: MarketView[];
  orders: IndexedOrder[];
  positions: PositionView[];
}) {
  const market = markets[0];
  if (!market) return null;
  const ids = new Set(markets.map((item) => item.id));
  const eventOrders = orders.filter((order) => ids.has(order.marketId));
  const openOrders = eventOrders.filter((order) => order.status === "open");
  const eventPositions = positions.filter((position) => ids.has(position.marketId));
  const claimCount = eventPositions.filter(hasClaims).length;
  const tradeMarket = markets.find((item) => item.lifecycle === "open");
  const probability = market.probability.value;

  return (
    <Card className="gap-0 rounded-xl bg-card pt-0 pb-2 ring-0 [&_tr]:border-0">
      <CardHeader className="flex flex-row items-start justify-between gap-5 border-0 px-5 py-6">
        <div className="min-w-0">
          <CardTitle className="text-lg leading-6 font-medium">{market.question}</CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground [&_[data-slot=badge]]:h-6 [&_[data-slot=badge]]:text-sm">
            <span>{markets.map((item) => item.ticker).join(" / ")}</span>
            <span aria-hidden="true">·</span>
            <LifecycleBadge state={market.lifecycle} />
            {probability !== null && Number.isFinite(probability) && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  Probability {formatNumber(probability * 100, 0)}%
                </span>
              </>
            )}
          </div>
        </div>
        {tradeMarket ? (
          <Button
            variant="secondary"
            size="sm"
            render={<Link href={`/markets/${tradeMarket.id}`} />}
            nativeButton={false}
          >
            Trade →
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled>
            Trade →
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Tabs defaultValue="positions" className="gap-0">
          <LineTabsList className="px-4">
            <LineTabsTrigger value="positions">Positions</LineTabsTrigger>
            <LineTabsTrigger value="orders">Open orders {openOrders.length || ""}</LineTabsTrigger>
            <LineTabsTrigger value="claims">Claims {claimCount || ""}</LineTabsTrigger>
          </LineTabsList>
          <TabsContent value="positions" className="min-w-0 overflow-x-auto px-2.5 pt-1">
            <PositionTable markets={markets} softClose />
          </TabsContent>
          <TabsContent value="orders" className="min-w-0 overflow-x-auto px-2.5 pt-1">
            <OrdersClient
              markets={markets}
              marketIds={markets.map((item) => item.id)}
              embedded
              fixedView="Open orders"
            />
          </TabsContent>
          <TabsContent value="claims" className="min-w-0 overflow-x-auto px-2.5 pt-1">
            <ClaimTable markets={markets} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
