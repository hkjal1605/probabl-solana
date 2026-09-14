import { getPayouts } from "@/services/portfolio-api-service";
import { payoutsStore } from "@/stores/usePayoutsStore";
import { fetchResource } from "@/utils/fetchResource";
export const fetchPayouts = (key: string, force = false) =>
  fetchResource(payoutsStore, key, (signal) => getPayouts(key, signal), force);
