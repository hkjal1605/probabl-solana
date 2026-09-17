import { getTrades } from "@/services/market-detail-api-service";
import { tradesStore } from "@/stores/useTradesStore";
import { fetchResource } from "@/utils/fetchResource";
export const fetchTrades = (key: string, force = false) =>
  fetchResource(
    tradesStore,
    key,
    (signal) => getTrades(key === "all" ? undefined : key, signal),
    force,
  );
