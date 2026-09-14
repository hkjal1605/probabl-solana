import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { MarketView } from "@/types/api";
export const marketsStore = createResourceStore<{ markets: MarketView[] }>("markets");
const useMarketsStore = createBoundedUseStore(marketsStore.store);
export default useMarketsStore;
