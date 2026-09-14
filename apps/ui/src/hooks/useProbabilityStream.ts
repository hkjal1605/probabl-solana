"use client";
import { useEffect } from "react";
import useProbabilityStore, { probabilityStore } from "@/stores/useProbabilityStore";
import { expireProbability } from "@/services/probability";
import { connectProbability } from "@/modules/MarketDetailPageModule/utils/subscribeProbability";
import type { ProbabilityView } from "@/types/api";

export function useProbabilityStream(conditionId: string, initial: ProbabilityView) {
  const entry = useProbabilityStore((s) => s.entries[conditionId]?.data);
  useEffect(() => {
    if (!conditionId) return;
    const stop = connectProbability(conditionId, initial);
    const timer = setInterval(() => {
      const current = probabilityStore.get(conditionId).data;
      if (current)
        probabilityStore.setData(conditionId, {
          ...current,
          probability: expireProbability(current.probability),
        });
    }, 1000);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [conditionId]);
  return entry ?? { probability: expireProbability(initial), connection: "disabled" as const };
}
