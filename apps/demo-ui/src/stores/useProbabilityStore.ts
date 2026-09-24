import type { ProbabilityView } from "@/types/api";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export type ProbabilityState = {
  probability: ProbabilityView;
  connection: "disabled" | "connecting" | "live" | "reconnecting";
};
export const probabilityStore = createResourceStore<ProbabilityState>("probability");
const useProbabilityStore = createBoundedUseStore(probabilityStore.store);
export default useProbabilityStore;
