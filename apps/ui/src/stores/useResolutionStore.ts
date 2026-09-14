import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { ResolutionView } from "@/types/api";
export const resolutionStore = createResourceStore<ResolutionView | null>("resolution");
const useResolutionStore = createBoundedUseStore(resolutionStore.store);
export default useResolutionStore;
