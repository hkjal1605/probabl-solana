import { getReadiness } from "@/services/market-detail-api-service";
import { readinessStore } from "@/stores/useReadinessStore";
import { fetchResource } from "@/utils/fetchResource";
export const fetchReadiness = (key: string, force = false) =>
  fetchResource(readinessStore, key, (signal) => getReadiness(key, signal), force);
