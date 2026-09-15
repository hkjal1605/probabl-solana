"use client";
import { useEffect } from "react";
import { useStore } from "zustand";
import { fetchMarkets } from "@/modules/MarketsPageModule/utils/fetchMarkets";
import { emptyResource } from "@/stores/createResourceStore";
import { marketsStore } from "@/stores/useMarketsStore";

/** Shared catalogue for search and asset navigation; no extra poller or spot subscription. */
export function useMarketCatalogue() {
  const entry = useStore(marketsStore.store, (state) => state.entries.all ?? emptyResource);
  useEffect(() => {
    if (marketsStore.get("all").data === undefined) void fetchMarkets("all");
  }, []);
  return {
    markets: entry.data?.markets ?? [],
    loading: entry.data === undefined && !entry.error,
    error: !!entry.error,
    retry: () => {
      void fetchMarkets("all", true);
    },
  };
}
