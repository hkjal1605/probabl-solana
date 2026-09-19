import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import {
  address,
  envelope,
  key,
  orderId,
  parseAtomicPlan,
  parseOrder,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "@conditional-stocks/solana-indexer/projection";
import type { Keypair } from "@solana/web3.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Authenticate } from "../auth/routes.ts";
import { indexedSnapshot } from "../chain/indexed-snapshot.ts";
import { submitDelegatedOrder, tradingPermission } from "./delegated-orders.ts";
import { mountOrderReview } from "./order-review.ts";
import type { createOrderPlan } from "./plan.ts";

export function mountTrading(
  app: Hono,
  options: {
    client: SolanaClient;
    db: SolanaDatabase;
    domain: string;
    authenticate: Authenticate;
    readIndex: () => Promise<Snapshot>;
    prepare: ReturnType<typeof createOrderPlan>;
    delegateSigner: Keypair | null;
  },
) {
  const { client, db, domain, authenticate, readIndex, prepare, delegateSigner } = options;
  mountOrderReview(app, prepare);
  app.get("/v1/trading/permission", async (c) => {
    const owner = address(c.req.query("owner"));
    return c.json(tradingPermission(await readIndex(), client, delegateSigner, owner));
  });
  app.post("/v1/trading/submit", async (c) => {
    const owner = await authenticate(c.req.header("authorization"));
    if (!delegateSigner)
      throw new HTTPException(503, { message: "Delegated trading is unavailable" });
    const order = parseOrder((await c.req.json()).order);
    return c.json(
      await submitDelegatedOrder({
        client,
        db,
        domain,
        signer: delegateSigner,
        owner,
        order,
        snapshot: readIndex,
        prepare,
      }),
    );
  });
  app.post("/v1/orders/transaction", async (c) => {
    const owner = await authenticate(c.req.header("authorization"));
    const body = await c.req.json();
    const order = parseOrder(body.order);
    if ((order.delegate ?? order.maker) !== owner)
      throw new Error("Order signer differs from session wallet");
    const plan = parseAtomicPlan(body.plan, order);
    if (BigInt(plan.deadline) <= BigInt(Math.floor(Date.now() / 1000)))
      throw new Error("Quote expired");
    const snapshot = await indexedSnapshot(db, client, domain);
    const market = snapshot.markets.get(order.marketId);
    if (!market) throw new Error("Unknown market");
    const transaction = envelope([client.placement(order, plan, market)], client.program);
    const built = await client.prepareTransaction(key(owner), transaction);
    const simulation = await client.connection.simulateTransaction(built.transaction, {
      sigVerify: false,
      commitment: "confirmed",
    });
    if (simulation.value.err)
      throw new Error(`Placement simulation failed: ${JSON.stringify(simulation.value.err)}`);
    return c.json({
      orderHash: orderId(order, client.program),
      executionVersion: 1,
      transaction,
    });
  });
  for (const kind of ["cancel", "recovery"])
    app.post(`/v1/orders/${kind}/prepare`, async (c) => {
      const owner = await authenticate(c.req.header("authorization"));
      const body = await c.req.json();
      const snapshot = await readIndex();
      const orderKey = key(address(body.orderHash));
      const order = snapshot.orders.get(String(orderKey));
      const market = order && snapshot.markets.get(String(order.market));
      if (!order || !market) throw new Error("Unknown indexed order");
      return c.json({
        transaction: envelope(
          [client.cancelIndexed(orderKey, key(owner), order, market)],
          client.program,
        ),
      });
    });
}
