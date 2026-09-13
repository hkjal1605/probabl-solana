"use client";
import { useMarkets } from "@/hooks/useProtocolData";
import type { MarketView } from "@/lib/api/types";
import { OrdersClient } from "./OrdersClient";
export function OrdersPageClient({ markets }: { markets: MarketView[] }) {
  return <OrdersClient markets={useMarkets(markets).markets} />;
}
