import { retainProbabilityDisplay } from "@/services/probability";
import { subscribeProbability } from "@/services/probability-stream";
import { probabilityStore } from "@/stores/useProbabilityStore";
import type { ProbabilityView } from "@/types/api";
export function connectProbability(condition: string, initial: ProbabilityView) {
  if (!probabilityStore.get(condition).data)
    probabilityStore.setData(condition, { probability: initial, connection: "connecting" });
  return subscribeProbability(
    condition,
    (probability) => {
      const previous = probabilityStore.get(condition).data?.probability;
      probabilityStore.setData(condition, {
        probability: previous ? retainProbabilityDisplay(previous, probability) : probability,
        connection: "live",
      });
    },
    (connection) => {
      const probability = probabilityStore.get(condition).data?.probability ?? initial;
      // Transport state must not erase a previously verified display value.
      probabilityStore.setData(condition, { connection, probability });
    },
  );
}
