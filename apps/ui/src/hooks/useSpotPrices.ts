"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SOLANA_API_ORIGIN } from "@conditional-stocks/shared/endpoints";
import {
  isSolanaMint,
  SPOT_BATCH_SIZE,
  SPOT_POLL_MS,
  SOLANA_MAINNET_GENESIS,
  type SpotPricesResponse,
} from "@conditional-stocks/shared/spot-prices";
import type { MarketView } from "@/lib/api/types";
import { protocolConfig } from "@/config/protocol";
import { fetchSpotPrices, parseSpotPricesResponse, spotPricesUrl } from "@/lib/api/spot-prices";
import { subscribeSpot } from "@/lib/api/spot-stream";

export function useSpotPrices(markets: MarketView[]) {
  const cache = useQueryClient();
  const [streamAt, setStreamAt] = useState(0);
  const [streamFallback, setStreamFallback] = useState(false);
  const base = process.env.NEXT_PUBLIC_API_URL ?? SOLANA_API_ORIGIN;
  const mints = [...new Set(markets.flatMap((m) => [m.baseToken, m.quoteToken]))]
    .filter(isSolanaMint)
    .sort();
  // All screens with the same assets share this query; backend deduplicates overlapping batches.
  const query = useQuery({
    queryKey: ["spot-prices", base, protocolConfig.genesisHash, mints],
    queryFn: async ({ signal }): Promise<SpotPricesResponse> => {
      const prices: SpotPricesResponse["prices"] = [];
      let asOf = 0;
      for (let i = 0; i < mints.length; i += SPOT_BATCH_SIZE) {
        const batch = await fetchSpotPrices(
          protocolConfig.genesisHash,
          mints.slice(i, i + SPOT_BATCH_SIZE),
          { base, signal },
        );
        prices.push(...batch.prices);
        asOf = Math.max(asOf, batch.asOf);
      }
      return {
        source: "jupiter",
        sourceGenesisHash: SOLANA_MAINNET_GENESIS,
        displayOnly: true,
        genesisHash: protocolConfig.genesisHash,
        asOf,
        prices,
      };
    },
    enabled: Boolean(protocolConfig.genesisHash && mints.length && (mints.length > SPOT_BATCH_SIZE || streamFallback)),
    staleTime: SPOT_POLL_MS,
    refetchInterval: () => Date.now() - streamAt < 30_000 ? false : SPOT_POLL_MS,
    retry: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const mintKey = mints.join(",");
  useEffect(() => {
    if (!mintKey || mints.length > SPOT_BATCH_SIZE) return;
    setStreamFallback(false);
    let received = false;
    const timer = setTimeout(() => { if (!received) setStreamFallback(true); }, 5000);
    const url = new URL(spotPricesUrl(mints, base));
    url.pathname += "/stream";
    const unsubscribe = subscribeSpot(url.toString(), (value) => {
      try {
        const prices = parseSpotPricesResponse(value, protocolConfig.genesisHash, mints);
        cache.setQueryData(["spot-prices", base, protocolConfig.genesisHash, mints], prices);
        setStreamAt(Date.now());
        received = true;
        setStreamFallback(false);
      } catch { setStreamAt(0); setStreamFallback(true); }
    }, () => { setStreamAt(0); setStreamFallback(true); });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [mintKey, base, cache]);
  useEffect(() => {
    if (!streamAt) return;
    const timer = setTimeout(() => setStreamFallback(true), 30_000);
    return () => clearTimeout(timer);
  }, [streamAt]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return { ...query, now };
}
