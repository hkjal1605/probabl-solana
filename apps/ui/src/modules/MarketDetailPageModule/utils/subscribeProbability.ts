import { subscribeProbability } from "@/services/probability-stream";
import { probabilityStore } from "@/stores/useProbabilityStore";
import type { ProbabilityView } from "@/types/api";
export function connectProbability(condition: string, initial: ProbabilityView) {
  return subscribeProbability(
    condition,
    (probability) => probabilityStore.setData(condition, { probability, connection: "live" }),
    (connection) => {
      const probability = probabilityStore.get(condition).data?.probability ?? initial;
      probabilityStore.setData(condition, {
        connection,
        probability:
          connection === "live"
            ? probability
            : { ...probability, value: null, quality: "disconnected" },
      });
    },
  );
}
