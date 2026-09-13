"use client";
import { useQuery } from "@tanstack/react-query";
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
import { fetchSpotPrices } from "@/lib/api/spot-prices";

export function useSpotPrices(markets: MarketView[]) {
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
    enabled: Boolean(protocolConfig.genesisHash && mints.length),
    staleTime: SPOT_POLL_MS,
    refetchInterval: SPOT_POLL_MS,
    retry: false,
  });
  const [now, setNow] = useState(() => Date.now());
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
