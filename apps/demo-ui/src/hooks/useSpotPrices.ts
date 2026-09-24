"use client";
import { isSolanaMint } from "@conditional-stocks/shared/spot-prices";
import { useEffect, useState } from "react";
import { fetchSpotPrices } from "@/modules/MarketDetailPageModule/utils/fetchSpotPrices";
import { spotPrices, subscribe } from "@/protocol/engine";
import { spotPricesStore } from "@/stores/useSpotPricesStore";
import type { MarketView } from "@/types/api";
import { useResource } from "./useResource";

export function useSpotPrices(markets: MarketView[]) {
  const mints = [...new Set(markets.flatMap((m) => [m.baseToken, m.quoteToken]))]
    .filter(isSolanaMint)
    .sort();
  const key = mints.join(",");
  const query = useResource(spotPricesStore, key, (force) => fetchSpotPrices(key, force), !!key);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!key) return;
    return subscribe(() => {
      spotPricesStore.setData(key, spotPrices(key.split(",")));
      spotPricesStore.patch(key, { streamUntil: Date.now() + 30_000 });
    });
  }, [key]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return { ...query, now };
}
