import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { PayoutPage } from "@/services/portfolio-api-service";
export const payoutsStore = createResourceStore<PayoutPage>("payout-credits");
const usePayoutsStore = createBoundedUseStore(payoutsStore.store);
export default usePayoutsStore;
