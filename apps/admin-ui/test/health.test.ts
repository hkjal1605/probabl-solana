import { expect, test } from "bun:test";

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
      expect(body.services.slice(1).map((service: { status: string }) => service.status)).toEqual([
        "unknown",
        "unknown",
        "unknown",
      ]);
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
