"use client";
import { useMarkets } from "@/hooks/useProtocolData";
import type { MarketView } from "@/types/api";
import { OrdersClient } from "./OrdersClient";
export function OrdersPageClient({ markets }: { markets: MarketView[] }) {
  return <OrdersClient markets={useMarkets(markets).markets} />;
}
