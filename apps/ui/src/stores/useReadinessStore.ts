import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";

export const readinessStore = createResourceStore<{
  healthy: boolean;
  reason?: string;
  checkedAt?: number;
}>("trading-readiness");
const useReadinessStore = createBoundedUseStore(readinessStore.store);
export default useReadinessStore;
