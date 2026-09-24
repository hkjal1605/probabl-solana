import { getPositions } from "@/services/portfolio-api-service";
import { positionsStore } from "@/stores/usePositionsStore";
import { fetchResource } from "@/utils/fetchResource";
export const fetchPositions = (key: string, force = false) =>
  fetchResource(positionsStore, key, (signal) => getPositions(key, signal), force);
