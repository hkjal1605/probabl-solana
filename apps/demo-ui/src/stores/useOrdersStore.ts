import type { OrdersPage } from "@/services/orders";
import createBoundedUseStore from "./createBoundedUseStore";
import { createResourceStore } from "./createResourceStore";
export const ordersStore = createResourceStore<OrdersPage>("wallet-orders");
const useOrdersStore = createBoundedUseStore(ordersStore.store);
export default useOrdersStore;
