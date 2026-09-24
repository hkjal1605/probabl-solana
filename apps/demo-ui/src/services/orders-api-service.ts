import { listOrders } from "@/protocol/engine";
import type { OrdersPage } from "./orders";

export const getOrders = async (_owner: string, _signal?: AbortSignal): Promise<OrdersPage> =>
  listOrders();
