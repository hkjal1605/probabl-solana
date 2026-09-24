import type { SpotPricesResponse } from "@conditional-stocks/shared/spot-prices";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export const spotPricesStore = createResourceStore<SpotPricesResponse>("spot-prices");
const useSpotPricesStore = createBoundedUseStore(spotPricesStore.store);
export default useSpotPricesStore;
