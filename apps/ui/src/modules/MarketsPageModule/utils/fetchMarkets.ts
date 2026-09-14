import { marketsApi } from "@/services/markets-api-service";
import { marketsStore } from "@/stores/useMarketsStore";
import { fetchResource } from "@/utils/fetchResource";
import { retainBookDisplays } from "@/lib/markets/refresh";
export const fetchMarkets = (key: string, force = false) =>
  fetchResource(
    marketsStore,
    key,
    async (signal) =>
      retainBookDisplays(marketsStore.get(key).data, {
        markets: await marketsApi.liveMarkets(key === "all" ? undefined : key, signal),
      }),
    force,
  );
