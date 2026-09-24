import type { TradeView } from "@/types/api";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export const tradesStore = createResourceStore<{ trades: TradeView[] }>("trades");
const useTradesStore = createBoundedUseStore(tradesStore.store);
export default useTradesStore;
