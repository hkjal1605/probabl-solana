import { createStore } from "zustand/vanilla";
import type { MarketCategory } from "@/lib/markets/presentation";

export type DiscoveryFilters = {
  category: MarketCategory;
  lifecycle: "active" | "resolving" | "all";
  sort: "newest" | "oldest";
  view: "Feed" | "Matrix";
};
export type OrderPrefill = {
  marketId: string;
  branch: "YES" | "NO";
  quantity: string;
  nonce: number;
};
export const defaultFilters: DiscoveryFilters = {
  category: "All",
  lifecycle: "active",
  sort: "newest",
  view: "Feed",
};

export function createUiStore() {
  return createStore<{
    filters: DiscoveryFilters;
    setFilters: (patch: Partial<DiscoveryFilters>) => void;
    prefill: OrderPrefill | null;
    setPrefill: (prefill: OrderPrefill | null) => void;
  }>()((set) => ({
    filters: { ...defaultFilters },
    setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
    prefill: null,
    setPrefill: (prefill) => set({ prefill }),
  }));
}
