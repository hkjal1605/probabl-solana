"use client";
import { useQuery } from "@tanstack/react-query";
import { protocolConfig } from "@/config/protocol";
import { api } from "@/lib/api/client";

export function useTradingReadiness(marketId: string) {
  const configured =
    Boolean(protocolConfig.config && protocolConfig.genesisHash);
  const query = useQuery({
    queryKey: ["trading-readiness", marketId, protocolConfig.chainId],
    queryFn: ({ signal }) => api.readiness(marketId, signal),
    enabled: configured,
    refetchInterval: 3000,
    retry: false,
    staleTime: 0,
  });
  const ready = configured && !query.isError && query.data?.healthy === true;
  return {
    ready,
    reason: !configured
      ? "Atomic trading contracts are not configured for this UI deployment."
      : query.isPending
        ? "Checking trading services…"
        : ready
          ? "Trading services ready"
          : "Trading is temporarily unavailable. Cancellation and claim recovery remain available.",
  };
}
