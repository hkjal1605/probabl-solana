import type { StreamWallet } from "@/services/index-stream";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export const positionsStore = createResourceStore<StreamWallet>("positions");
const usePositionsStore = createBoundedUseStore(positionsStore.store);
export default usePositionsStore;
