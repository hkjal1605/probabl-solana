import { spotPrices } from "@/protocol/engine";
import { spotPricesStore } from "@/stores/useSpotPricesStore";
import { fetchResource } from "@/utils/fetchResource";

export const fetchSpotPrices = (key: string, force = false) =>
  fetchResource(spotPricesStore, key, async () => spotPrices(key.split(",")), force);
