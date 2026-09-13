import { createStore } from "zustand/vanilla";

export type DiscoveryFilters = {
  query: string;
  category: string;
  lifecycle: "active" | "resolving" | "all";
  sort: "depth" | "impact" | "cutoff";
  view: "Feed" | "Matrix";
};
export type FundsTab = "Deposit" | "Withdraw" | "Permissions";
export type OrderPrefill = {
  marketId: string;
  branch: "YES" | "NO";
  quantity: string;
  nonce: number;
};
export const defaultFilters: DiscoveryFilters = {
  query: "",
  category: "All",
  lifecycle: "active",
  sort: "depth",
  view: "Feed",
};

export function createUiStore() {
  return createStore<{
    filters: DiscoveryFilters;
    setFilters: (patch: Partial<DiscoveryFilters>) => void;
    funds: FundsTab | null;
    setFunds: (tab: FundsTab | null) => void;
    prefill: OrderPrefill | null;
    setPrefill: (prefill: OrderPrefill | null) => void;
  }>()((set) => ({
    filters: { ...defaultFilters },
    setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
    funds: null,
    setFunds: (funds) => set({ funds }),
    prefill: null,
    setPrefill: (prefill) => set({ prefill }),
  }));
}
