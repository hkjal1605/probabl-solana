import { getOrders } from "@/services/orders-api-service";
import { ordersStore } from "@/stores/useOrdersStore";
import { fetchResource } from "@/utils/fetchResource";
export const fetchOrders = (key: string, force = false) =>
  fetchResource(ordersStore, key, (signal) => getOrders(key, signal), force);
