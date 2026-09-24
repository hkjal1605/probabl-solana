"use client";
import { protocolConfig } from "@/config/protocol";
import { localTradingStatus, readinessMessage, requireTradingReady } from "@/lib/trading/readiness";
import { fetchReadiness } from "@/modules/MarketDetailPageModule/utils/fetchReadiness";
import { api } from "@/services/protocol-api-service";
import { readinessStore } from "@/stores/useReadinessStore";
import type { MarketView } from "@/types/api";
import { useReadFreshness } from "./useReadFreshness";
import { useResource } from "./useResource";

export function useTradingReadiness(market: MarketView) {
  const configured = Boolean(protocolConfig.config && protocolConfig.genesisHash);
  const query = useResource(
    readinessStore,
    market.id,
    (force) => fetchReadiness(market.id, force),
    configured,
  );
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
      await requireTradingReady(market, async () => api.readiness(market.id));
    },
  };
}
