import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";

export const readinessStore = createResourceStore<{
  healthy: boolean;
  reason?: string;
  checkedAt?: number;
}>("trading-readiness");
const useReadinessStore = createBoundedUseStore(readinessStore.store);
export default useReadinessStore;
