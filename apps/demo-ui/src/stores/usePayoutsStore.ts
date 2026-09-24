import type { PayoutPage } from "@/services/portfolio-api-service";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export const payoutsStore = createResourceStore<PayoutPage>("payout-credits");
const usePayoutsStore = createBoundedUseStore(payoutsStore.store);
export default usePayoutsStore;
