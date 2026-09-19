import { SOLANA_API_ORIGIN } from "@conditional-stocks/shared/endpoints";
import { serviceOrigin } from "@/lib/upstream";

export async function GET() {
  // Read overrides per request, like the Solana/indexer proxies. The public
  // deployment multiplexes health routes; /health alone identifies the API.
  const apiOrigin = process.env.API_URL ?? SOLANA_API_ORIGIN;
  const indexerOrigin =
    process.env.INDEXER_HEALTH_ORIGIN ??
    process.env.INDEXER_URL ??
    SOLANA_API_ORIGIN;
  const isPublicOrigin = (origin: string) =>
    origin.replace(/\/$/, "") === SOLANA_API_ORIGIN;
  const polymarketOrigin =
    process.env.POLYMARKET_INGESTOR_URL ??
    (isPublicOrigin(apiOrigin) ? SOLANA_API_ORIGIN : "");
  const services = [
    { name: "Solana API", url: apiOrigin, path: "/ready" },
    {
      name: "Chain indexer",
      // Optional separate origin for private health checks (empty disables the probe).
      url: indexerOrigin,
      path: isPublicOrigin(indexerOrigin) ? "/indexer-health" : "/health",
    },
    {
      name: "Polymarket ingestor",
      url: polymarketOrigin,
      path: isPublicOrigin(polymarketOrigin) ? "/polymarket-health" : "/health",
    },
    {
      name: "Reconciler",
      // Reconciliation is deliberately private. /ready includes its readiness gate.
      url: process.env.RECONCILIATION_URL ?? "",
      path: "/reconciliation",
    },
  ];
  const results = await Promise.all(
    services.map(async (service) => {
      if (!service.url)
        return {
          detail: "Health URL not configured",
          name: service.name,
          status: "unknown",
        };
      const started = Date.now();
      try {
        const response = await fetch(
          new URL(service.path, serviceOrigin(service.url, service.name)),
          {
            cache: "no-store",
            redirect: "manual",
            signal: AbortSignal.timeout(2_500),
          },
        );
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error("Health endpoint redirects are not permitted");
        }
        const body = await response.json().catch(() => null);
        return {
          detail: body,
          latencyMs: Date.now() - started,
          name: service.name,
          status:
            response.ok &&
            body &&
            (body.healthy === true || body.status === "ok")
              ? "healthy"
              : "degraded",
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
