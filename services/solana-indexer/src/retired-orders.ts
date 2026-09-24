import { coder, orderId, orderWire, type OrderAccount } from "@conditional-stocks/solana-client";
import type { Snapshot } from "./projection";

const ORDER_ACCOUNT_BYTES = coder.accounts.size("Order");

export interface RetiredOrderImage {
  address: string;
  data: string;
}

/** Decodes and authenticates one archival (closed) order image. Returns
 * undefined for another deployment's markets. */
export function retiredOrder(snapshot: Pick<Snapshot, "markets" | "program">, image: RetiredOrderImage) {
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length !== ORDER_ACCOUNT_BYTES) throw new Error("Invalid retired order size");
  const order = coder.accounts.decode("Order", bytes) as OrderAccount;
  if (!snapshot.markets.has(order.market.toBase58())) return undefined;
  if (
    orderId(orderWire(order), snapshot.program) !== image.address ||
    ![2, 3].includes(order.status) ||
    !order.remaining.isZero() ||
    !order.reserved.isZero() ||
    !order.open_notional.isZero()
  )
    throw new Error("Invalid retired order image");
  return order;
}

/** Historical images are not live chain accounts. Never merge them into the
 * RPC account image or accept an open/reserved order from archival events. */
export function restoreRetiredOrders(snapshot: Snapshot, images: RetiredOrderImage[]) {
  for (const image of images) {
    const order = retiredOrder(snapshot, image);
    if (!order) continue;
    if (snapshot.orders.has(image.address))
      throw new Error("Retired order address unexpectedly exists");
    snapshot.orders.set(image.address, order);
  }
}

/** Closed (retired) orders kept beside the immutable live snapshots, so order
 * history survives rent recovery without copying the live order map. */
export class RetiredOrders {
  private readonly orders = new Map<string, OrderAccount>();
  add(snapshot: Pick<Snapshot, "markets" | "program">, images: RetiredOrderImage[]) {
    for (const image of images) {
      const order = retiredOrder(snapshot, image);
      if (order) this.orders.set(image.address, order);
    }
  }
  /** Retired orders not (or no longer) present as live accounts. */
  *entries(live: ReadonlyMap<string, OrderAccount>): Iterable<[string, OrderAccount]> {
    for (const entry of this.orders) if (!live.has(entry[0])) yield entry;
  }
}

export function retiredOrderImages(
  rows: { data: { account?: unknown; data?: unknown } }[],
): RetiredOrderImage[] {
  return rows.map(({ data }) => {
    if (
      typeof data.account !== "string" ||
      !Array.isArray(data.data) ||
      data.data.length !== ORDER_ACCOUNT_BYTES ||
      data.data.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    )
      throw new Error("Invalid retired order event");
    return { address: data.account, data: Buffer.from(data.data).toString("base64") };
  });
}
