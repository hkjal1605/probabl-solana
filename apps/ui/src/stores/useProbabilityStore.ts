import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { ProbabilityView } from "@/types/api";
export type ProbabilityState = {
  probability: ProbabilityView;
  connection: "disabled" | "connecting" | "live" | "reconnecting";
};
export const probabilityStore = createResourceStore<ProbabilityState>("probability");
const useProbabilityStore = createBoundedUseStore(probabilityStore.store);
export default useProbabilityStore;
