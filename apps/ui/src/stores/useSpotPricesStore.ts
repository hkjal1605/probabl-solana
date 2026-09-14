import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { SpotPricesResponse } from "@conditional-stocks/shared/spot-prices";
export const spotPricesStore = createResourceStore<SpotPricesResponse>("spot-prices");
const useSpotPricesStore = createBoundedUseStore(spotPricesStore.store);
export default useSpotPricesStore;
