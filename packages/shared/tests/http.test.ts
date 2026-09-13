import { expect, test } from "bun:test";
import { Hono } from "hono";
import { requestLogging } from "../src/http.ts";
import { Logger, type LogRecord } from "../src/logger.ts";

test("HTTP middleware logs every outcome once, including handled errors, without consuming bodies", async () => {
  const records: LogRecord[] = [];
  const logger = new Logger({
    service: "api",
    level: "debug",
    sink: (record) => records.push(record),
  });
  const app = new Hono();
  app.use("*", requestLogging(logger));
  app.onError((_error, context) => context.json({ error: "unavailable" }, 503));
  app.post("/orders/:id", async (context) => context.json({ read: await context.req.json() }));
  app.get("/fail", () => {
    throw Object.assign(new Error("Bearer error-secret"), { code: "SOURCE_DOWN" });
  });
  app.get("/denied", (context) => context.json({ error: "unauthorized" }, 401));
  const success = await app.request("/orders/path-secret?token=query-secret", {
    method: "POST",
    headers: {
      authorization: "Bearer header-secret",
      "content-type": "application/json",
      "x-request-id": "caller-secret",
    },
    body: JSON.stringify({ signature: "body-secret" }),
  });
  expect((await success.json()).read.signature).toBe("body-secret");
  expect(success.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  const failed = await app.request("/fail");
  await app.request("/denied");
  await app.request("/not-found-secret");
  expect(records).toHaveLength(4);
  expect(records.map((record) => record.fields.status)).toEqual([200, 503, 401, 404]);
  expect(records.map((record) => record.level)).toEqual(["info", "error", "warn", "warn"]);
  expect(records[0]?.fields.route).toBe("/orders/:id");
  expect(records[1]?.fields.requestId).toBe(failed.headers.get("x-request-id"));
  expect(records[1]?.fields.error).toHaveProperty("code", "SOURCE_DOWN");
  const text = JSON.stringify(records);
  for (const secret of [
    "path-secret",
    "query-secret",
    "header-secret",
    "body-secret",
    "caller-secret",
    "error-secret",
    "not-found-secret",
  ])
    expect(text).not.toContain(secret);
});

test("concurrent requests keep independent correlation IDs", async () => {
  const records: LogRecord[] = [];
  const app = new Hono();
  app.use(
    "*",
    requestLogging(new Logger({ service: "test", sink: (record) => records.push(record) })),
  );
  app.get("/", async (context) => {
    await Promise.resolve();
    return context.text("ok");
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => app.request("/")));
  const ids = new Set(results.map((response) => response.headers.get("x-request-id")));
  expect(ids.size).toBe(10);
  expect(new Set(records.map((record) => record.fields.requestId))).toEqual(ids);
});
