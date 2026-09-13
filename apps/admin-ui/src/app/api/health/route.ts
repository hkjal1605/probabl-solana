const services = [
  { name: "API gateway", url: process.env.API_URL ?? "http://127.0.0.1:3000", path: "/ready" },
  {
    name: "Chain indexer",
    // Optional separate origin for private health checks (empty disables the probe).
    url: process.env.INDEXER_HEALTH_ORIGIN ?? process.env.INDEXER_URL ?? "http://127.0.0.1:42069",
    path: "/health",
  },
  {
    name: "Polymarket ingestor",
    url: process.env.POLYMARKET_INGESTOR_URL ?? "http://127.0.0.1:42073",
    path: "/health",
  },
  {
    name: "Reconciler",
    url: process.env.RECONCILIATION_URL ?? process.env.INDEXER_URL ?? "http://127.0.0.1:42069",
    path: "/reconciliation",
  },
];
export async function GET() {
  const results = await Promise.all(
    services.map(async (service) => {
      if (!service.url)
        return { detail: "Health URL not configured", name: service.name, status: "unknown" };
      const started = Date.now();
      try {
        const response = await fetch(new URL(service.path, service.url), {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(2_500),
        });
        const body = await response.json().catch(() => null);
        return {
          detail: body,
          latencyMs: Date.now() - started,
          name: service.name,
          status: response.ok && body && body.healthy !== false ? "healthy" : "degraded",
        };
      } catch {
        return {
          detail: "No response",
          latencyMs: Date.now() - started,
          name: service.name,
          status: "offline",
        };
      }
    }),
  );
  return Response.json(
    { checkedAt: new Date().toISOString(), services: results },
    { headers: { "cache-control": "private, no-store" } },
  );
}
