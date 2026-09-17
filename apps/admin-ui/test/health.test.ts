import { afterEach, expect, test } from "bun:test";
import { GET } from "../src/app/api/health/route";

const keys = [
  "API_URL",
  "INDEXER_URL",
  "INDEXER_HEALTH_ORIGIN",
  "POLYMARKET_INGESTOR_URL",
  "RECONCILIATION_URL",
];
const previousEnvironment = Object.fromEntries(
  keys.map((key) => [key, process.env[key]]),
);
const savedFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("public health defaults use the correct HTTPS aliases and do not call private reconciliation", async () => {
  for (const key of keys) delete process.env[key];
  const calls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    expect(init?.redirect).toBe("manual");
    return Response.json(
      String(url).endsWith("/polymarket-health")
        ? { status: "ok" }
        : { healthy: true },
    );
  }) as typeof fetch;
  const body = await (await GET()).json();
  expect(calls).toEqual([
    "https://api-solana.probabl.trade/ready",
    "https://api-solana.probabl.trade/indexer-health",
    "https://api-solana.probabl.trade/polymarket-health",
  ]);
  expect(
    body.services.map((service: { status: string }) => service.status),
  ).toEqual(["healthy", "healthy", "healthy", "unknown"]);
});

test("explicit private health origins and runtime changes are respected", async () => {
  Object.assign(process.env, {
    API_URL: "http://127.0.0.1:3000",
    INDEXER_URL: "http://127.0.0.1:42069",
    INDEXER_HEALTH_ORIGIN: "https://indexer.test",
    POLYMARKET_INGESTOR_URL: "https://reference.test",
    RECONCILIATION_URL: "https://reconciler.test",
  });
  const calls: string[] = [];
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ healthy: true });
  }) as typeof fetch;
  await GET();
  expect(calls).toEqual([
    "http://127.0.0.1:3000/ready",
    "https://indexer.test/health",
    "https://reference.test/health",
    "https://reconciler.test/reconciliation",
  ]);
  calls.length = 0;
  process.env.INDEXER_HEALTH_ORIGIN = "https://api-solana.probabl.trade/";
  process.env.POLYMARKET_INGESTOR_URL = "https://api-solana.probabl.trade/";
  await GET();
  expect(calls.slice(1, 3)).toEqual([
    "https://api-solana.probabl.trade/indexer-health",
    "https://api-solana.probabl.trade/polymarket-health",
  ]);
});

test("malformed health responses are degraded and network errors are offline", async () => {
  for (const key of keys) delete process.env[key];
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/ready")) return Response.json({});
    if (String(url).endsWith("/indexer-health")) throw new Error("offline");
    return new Response("invalid JSON");
  }) as typeof fetch;
  const body = await (await GET()).json();
  expect(
    body.services.map((service: { status: string }) => service.status),
  ).toEqual(["degraded", "offline", "degraded", "unknown"]);
});

test("private probes can be disabled without hiding public API readiness failures", async () => {
  const environment = {
    API_URL: "https://api.example.test",
    INDEXER_URL: "https://api.example.test",
    INDEXER_HEALTH_ORIGIN: "",
    POLYMARKET_INGESTOR_URL: "",
    RECONCILIATION_URL: "",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  try {
    Object.assign(process.env, environment);
    const { GET } = await import("../src/app/api/health/route");
    for (const [status, healthy] of [
      [200, true],
      [200, false],
      [503, false],
    ] as const) {
      let calls = 0;
      globalThis.fetch = (async (url, options) => {
        calls++;
        expect(String(url)).toBe("https://api.example.test/ready");
        expect(options?.cache).toBe("no-store");
        return Response.json({ healthy }, { status });
      }) as typeof fetch;
      const response = await GET();
      const body = await response.json();
      expect(calls).toBe(1);
      expect(body.services[0].status).toBe(healthy ? "healthy" : "degraded");
      expect(
        body.services
          .slice(1)
          .map((service: { status: string }) => service.status),
      ).toEqual(["unknown", "unknown", "unknown"]);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
