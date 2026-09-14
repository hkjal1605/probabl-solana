import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { TradeView } from "@/types/api";
export const tradesStore = createResourceStore<{ trades: TradeView[] }>("trades");
const useTradesStore = createBoundedUseStore(tradesStore.store);
export default useTradesStore;
