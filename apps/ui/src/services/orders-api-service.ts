import { requestJson } from "./api";
import type { OrdersPage } from "./orders";
export const getOrders = (owner: string, signal: AbortSignal) =>
  requestJson<OrdersPage>(`/orders?maker=${encodeURIComponent(owner)}&limit=1000`, { signal });
