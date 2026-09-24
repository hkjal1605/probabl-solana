import type { ResolutionView } from "@/types/api";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export const resolutionStore = createResourceStore<ResolutionView | null>("resolution");
const useResolutionStore = createBoundedUseStore(resolutionStore.store);
export default useResolutionStore;
