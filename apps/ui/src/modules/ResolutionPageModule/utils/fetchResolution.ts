import { getResolution } from "@/services/market-detail-api-service";
import { resolutionStore } from "@/stores/useResolutionStore";
import { fetchResource } from "@/utils/fetchResource";
export const fetchResolution = (key: string, force = false) =>
  fetchResource(resolutionStore, key, (signal) => getResolution(key, signal), force);
