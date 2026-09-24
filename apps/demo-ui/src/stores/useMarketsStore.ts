import type { MarketView } from "@/types/api";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export const marketsStore = createResourceStore<{ markets: MarketView[] }>("markets");
const useMarketsStore = createBoundedUseStore(marketsStore.store);
export default useMarketsStore;
