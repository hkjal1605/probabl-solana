import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { StreamWallet } from "@/services/index-stream";
export const positionsStore = createResourceStore<StreamWallet>("positions");
const usePositionsStore = createBoundedUseStore(positionsStore.store);
export default usePositionsStore;
