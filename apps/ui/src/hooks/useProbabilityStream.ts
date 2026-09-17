"use client";
import { useEffect, useRef } from "react";
import { connectProbability } from "@/modules/MarketDetailPageModule/utils/subscribeProbability";
import { expireCachedProbability } from "@/services/probability";
import useProbabilityStore, { probabilityStore } from "@/stores/useProbabilityStore";
import type { ProbabilityView } from "@/types/api";

export function useProbabilityStream(conditionId: string, initial: ProbabilityView) {
  const entry = useProbabilityStore((s) => s.entries[conditionId]?.data);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (!conditionId) return;
    const stop = connectProbability(conditionId, initialRef.current);
    const timer = setInterval(() => {
      const current = probabilityStore.get(conditionId).data;
      if (current) {
        const probability = expireCachedProbability(current.probability);
        if (
          probability.quality !== current.probability.quality ||
          probability.value !== current.probability.value
        )
          probabilityStore.setData(conditionId, {
            ...current,
            probability,
          });
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [conditionId]);
  useEffect(() => {
    if (!conditionId || initial.value === null || !Number.isFinite(initial.value)) return;
    const current = probabilityStore.get(conditionId).data;
    const currentAt = current?.probability.observedAt
      ? Date.parse(current.probability.observedAt)
      : Number.NEGATIVE_INFINITY;
    const initialAt = initial.observedAt
      ? Date.parse(initial.observedAt)
      : Number.NEGATIVE_INFINITY;
    // HTTP catalogue refreshes can recover a display value while an SSE feed is
    // disconnected. Promote that recovery without reconnecting the shared stream.
    if (
      !current ||
      current.probability.value === null ||
      (initial.quality === "valid" &&
        current.probability.quality !== "valid" &&
        initialAt >= currentAt)
    )
      probabilityStore.setData(conditionId, {
        connection: current?.connection ?? "connecting",
        probability: initial,
      });
  }, [conditionId, initial]);
  return (
    entry ?? { probability: expireCachedProbability(initial), connection: "disabled" as const }
  );
}
