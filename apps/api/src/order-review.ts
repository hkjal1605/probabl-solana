import type { Hono } from "hono";
import { parseOrder, type OrderWire } from "@conditional-stocks/solana-client";

export function mountOrderReview(
  app: Hono,
  prepare: (order: OrderWire) => Promise<unknown>,
) {
  // Public, read-only quote preparation: no signing, broadcasting or state writes.
  // Ownership is still authenticated by the transaction endpoint and enforced on-chain.
  app.post("/v1/orders/prepare", async (c) => {
    const order = parseOrder((await c.req.json()).order);
    return c.json(await prepare(order));
  });
}
