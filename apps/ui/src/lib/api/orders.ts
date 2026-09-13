import type { IndexedOrder } from "./types";
export interface OrdersPage {
  orders: IndexedOrder[];
  truncated?: boolean;
}
/** Keep old resting orders visible even when the recent-history window fills up. Prefer the newest canonical update across concurrent reads. */
export function mergeOrderPages(recent: OrdersPage, open: OrdersPage) {
  const orders = new Map<string, IndexedOrder>();
  for (const row of [...recent.orders, ...open.orders]) {
    const previous = orders.get(row.id);
    if (!previous || BigInt(row.updatedBlock) > BigInt(previous.updatedBlock))
      orders.set(row.id, row);
  }
  return {
    orders: [...orders.values()],
    truncated: recent.truncated ?? false,
    openTruncated: open.truncated ?? false,
  };
}
