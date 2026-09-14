import { expect, test } from "bun:test";
import { Hono } from "hono";
import { browserCors } from "../src/browser-cors";

const app = new Hono();
app.use("*", browserCors(["http://localhost:3000", "https://probabl.trade"]));
app.post("/v1/orders/prepare", (c) => c.json({ error: "unauthenticated" }, 401));

test("direct browser preflight allows configured origins and explicit bearer headers, not cookies", async () => {
  const response = await app.request("/v1/orders/prepare", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
    "authorization",
  );
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
});

test("CORS does not authorize requests and never reflects a foreign or lookalike origin", async () => {
  for (const origin of ["https://probabl.trade", "https://probabl.trade.evil.test", "null"]) {
    const response = await app.request("/v1/orders/prepare", {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      origin === "https://probabl.trade" ? origin : null,
    );
  }
});
