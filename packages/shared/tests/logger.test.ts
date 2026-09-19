import { describe, expect, test } from "bun:test";
import { Logger, type LogRecord, logLevel, sanitizeLogFields } from "../src/logger.ts";

describe("shared structured logger", () => {
  test("has stable metadata, levels, child context and precise raw integers", () => {
    const records: LogRecord[] = [];
    const logger = new Logger({
      service: "api",
      fields: { chainId: 4663 },
      now: () => new Date("2026-09-07T00:00:00Z"),
      sink: (record) => records.push(record),
    });
    logger.debug("ignored");
    const child = logger.child({ requestId: "request-1" });
    child.info("order.accepted", { quantity: 10n ** 30n, orderHash: `0x${"ab".repeat(32)}` });
    logger.warn("root");
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      timestamp: "2026-09-07T00:00:00.000Z",
      service: "api",
      level: "info",
      event: "order.accepted",
      fields: {
        chainId: 4663,
        requestId: "request-1",
        quantity: "1000000000000000000000000000000",
        orderHash: `0x${"ab".repeat(32)}`,
      },
    });
    expect(records[1]?.fields).not.toHaveProperty("requestId");
    expect(logLevel(undefined)).toBe("info");
    expect(logLevel("debug")).toBe("debug");
    expect(() => logLevel("everything")).toThrow("LOG_LEVEL");
  });

  test("redacts credentials, request bodies, signatures, RPC URLs and unsafe error context", () => {
    const records: LogRecord[] = [];
    const logger = new Logger({ service: "worker", sink: (record) => records.push(record) });
    const error = Object.assign(
      new Error(
        "RPC https://provider.test/keysecret?api_key=xyz failed; Bearer bearer-secret; password=pw-secret; signed 0x" +
          "cd".repeat(100),
      ),
      {
        code: "RPC_UNAVAILABLE",
        details: { privateKey: "details-secret" },
        cause: new Error("cause-secret"),
      },
    );
    logger.error("rpc.failed", {
      error,
      authorization: "auth-secret",
      nested: {
        PRIVATE_KEY: "key-secret",
        accessToken: "access-secret",
        cookie: "cookie-secret",
        signature: "sig-secret",
        rawTransaction: "tx-secret",
        DATABASE_URL: "db-secret",
      },
      body: { amount: 1, token: "body-secret" },
      env: { apiKey: "env-secret" },
    });
    const encoded = JSON.stringify(records);
    for (const value of [
      "keysecret",
      "bearer-secret",
      "pw-secret",
      "details-secret",
      "cause-secret",
      "auth-secret",
      "key-secret",
      "access-secret",
      "cookie-secret",
      "sig-secret",
      "tx-secret",
      "db-secret",
      "body-secret",
      "env-secret",
      "cd".repeat(100),
    ])
      expect(encoded).not.toContain(value);
    expect(encoded).toContain("RPC_UNAVAILABLE");
    expect(encoded).toContain("[REDACTED]");
  });

  test("bounds cycles and large payloads without invoking accessors or toJSON", () => {
    let invoked = false;
    const fields: Record<string, unknown> = {
      quantity: 7n,
      huge: "a".repeat(10000),
      toJSON: () => {
        invoked = true;
        return "secret";
      },
    };
    fields.cycle = fields;
    Object.defineProperty(fields, "getter", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "secret";
      },
    });
    const error = new Error("safe");
    const items = [1];
    for (const [value, key] of [
      [error, "message"],
      [items, "0"],
    ] as const)
      Object.defineProperty(value, key, {
        get: () => {
          invoked = true;
          return "secret";
        },
      });
    fields.error = error;
    fields.items = items;
    const records: LogRecord[] = [];
    const logger = new Logger({ service: "test", sink: (record) => records.push(record) });
    logger.child(fields).info("bounded", fields);
    expect(invoked).toBe(false);
    expect(JSON.stringify(records)).not.toContain("secret");
    expect(JSON.stringify(records).length).toBeLessThan(3000);
    expect(sanitizeLogFields({ fields }).fields).toHaveProperty("cycle", "[CIRCULAR]");
  });

  test("disabled logs and broken transports never affect application behavior", () => {
    const sink = () => {
      throw new Error("sink down");
    };
    expect(() => new Logger({ service: "browser", sink }).error("render.failed")).not.toThrow();
    const records: LogRecord[] = [];
    new Logger({ service: "test", level: "silent", sink: (record) => records.push(record) }).error(
      "ignored",
    );
    expect(records).toHaveLength(0);
  });

  test("browser entrypoint bundles without Bun, Node, database or HTTP dependencies", async () => {
    const build = await Bun.build({
      entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
      target: "browser",
    });
    expect(build.success).toBe(true);
    const code = await build.outputs[0]?.text();
    expect(code).toBeDefined();
    for (const forbidden of ["bun:sqlite", "node:", 'from "hono"'])
      expect(code).not.toContain(forbidden);
  });
});
