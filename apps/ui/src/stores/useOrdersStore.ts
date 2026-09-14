import { createResourceStore } from "./createResourceStore";
import createBoundedUseStore from "./createBoundedUseStore";
import type { OrdersPage } from "@/services/orders";
export const ordersStore = createResourceStore<OrdersPage>("wallet-orders");
const useOrdersStore = createBoundedUseStore(ordersStore.store);
export default useOrdersStore;
