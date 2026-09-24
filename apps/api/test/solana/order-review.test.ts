import { expect, test } from "bun:test";
import { PublicKey } from "@conditional-stocks/solana-client";
import { Hono } from "hono";
import { mountOrderReview } from "../../src/solana/trading/order-review.ts";

const account = PublicKey.unique().toBase58();
const order = {
  maker: account,
  recipient: account,
  marketId: PublicKey.unique().toBase58(),
  salt: "0x" + "22".repeat(32),
  quantity: "1000000",
  limitPriceRawX18: "5000000000000000000",
  expiry: "2000",
  nonce: "1",
  maxFeeBps: 0,
  branch: 0,
  side: 0,
  fundingKind: 0,
  tif: 0,
  bases: 3,
};

test("order review accepts an unsigned request without a session", async () => {
  const app = new Hono();
  let calls = 0;
  mountOrderReview(app, async (candidate) => {
    calls++;
    expect(candidate).toEqual(order);
    return { order: candidate, notional: "5000000" };
  });
  const response = await app.request("/v1/orders/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ order, notional: "5000000" });
  expect(calls).toBe(1);
});

test("public review rejects invalid orders before performing RPC work", async () => {
  const app = new Hono();
  app.onError(() => new Response("Invalid order", { status: 400 }));
  let calls = 0;
  mountOrderReview(app, async () => {
    calls++;
    return {};
  });
  for (const body of [
    {},
    { order: { ...order, maker: "invalid" } },
    { order: { ...order, quantity: "-1" } },
    { order: { ...order, branch: 2 } },
    { order: { ...order, bases: 0 } },
    { order: { ...order, bases: 8 } },
    { order: { ...order, side: 1, bases: 3 } },
  ]) {
    const response = await app.request("/v1/orders/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(0);
});

test("review uses conditional session recovery without sending a transaction; submission remains authenticated", async () => {
  const source = await Bun.file(
    new URL("../../../ui/src/hooks/useOrderTicket.ts", import.meta.url),
  ).text();
  const review = source.split("const prepareAction =")[1]!.split("const latestPrepare =")[0]!;
  expect(review).toContain("reviewWithSession({");
  expect(review).not.toContain("wallet.sendTransaction");
  expect(review).toContain("token: wallet.sessionToken");
  const api = await Bun.file(new URL("../../src/solana/trading/routes.ts", import.meta.url)).text();
  const transaction = api
    .split('app.post("/v1/orders/transaction"')[1]!
    .split("for (const kind")[0]!;
  expect(transaction).toContain('authenticate(c.req.header("authorization"))');
  expect(transaction).toContain("(order.delegate ?? order.maker) !== owner");
});
