import { type OrderWire, parseOrder } from "@conditional-stocks/solana-client";
import type { Hono } from "hono";

export function mountOrderReview(app: Hono, prepare: (order: OrderWire) => Promise<unknown>) {
  // Public, read-only quote preparation: no signing, broadcasting or state writes.
  // Ownership is still authenticated by the transaction endpoint and enforced on-chain.
  app.post("/v1/orders/prepare", async (c) => {
    const order = parseOrder((await c.req.json()).order);
    return c.json(await prepare(order));
  });
}
