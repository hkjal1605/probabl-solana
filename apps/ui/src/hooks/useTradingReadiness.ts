"use client";
import { useQuery } from "@tanstack/react-query";
import { protocolConfig } from "@/config/protocol";
import { api } from "@/lib/api/client";
import type { MarketView } from "@/lib/api/types";
import { readPollInterval } from "@/lib/api/read-policy";
import { localTradingStatus, readinessMessage, requireTradingReady } from "@/lib/trading/readiness";
import { useReadFreshness } from "./useReadFreshness";

export function useTradingReadiness(market: MarketView) {
  const configured = Boolean(protocolConfig.config && protocolConfig.genesisHash);
  const query = useQuery({
    queryKey: [
      "trading-readiness",
      market.id,
      protocolConfig.genesisHash,
      protocolConfig.programId,
      protocolConfig.config,
    ],
    queryFn: ({ signal }) => api.readiness(market.id, signal),
    enabled: configured,
    refetchInterval: readPollInterval,
    staleTime: 5000,
  });
  const freshness = useReadFreshness(query, 15_000);
  const local = localTradingStatus(market);
  const ready =
    configured && freshness.isDataFresh && query.data?.healthy === true && local === "ready";
  return {
    ready,
    reason: !configured
      ? "Atomic trading contracts are not configured for this UI deployment."
      : ready
        ? "Trading services ready"
        : readinessMessage(
            local !== "ready" ? local : freshness.isDataFresh ? query.data?.reason : undefined,
          ),
    // An explicitly requested action always rechecks, regardless of cached UI status.
    requireReady: async () => {
      if (!configured) throw new Error("Trading is not configured.");
      await requireTradingReady(market, () => api.readiness(market.id));
    },
  };
}
