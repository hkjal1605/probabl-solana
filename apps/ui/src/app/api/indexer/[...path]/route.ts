import type { NextRequest } from "next/server";
import { privateResponseHeaders, upstreamUrl } from "@/lib/api/upstream";
import { logger } from "@/lib/logger";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  // Public UI must never tunnel the indexer's service-only endpoints.
  if (
    path.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)) ||
    ![
      "markets",
      "orders",
      "orderbook",
      "trades",
      "balances",
      "positions",
      "payouts",
      "resolutions",
      "transactions",
    ].includes(path[0] ?? "")
  )
    return Response.json(
      { error: "route-not-public" },
      { status: 404, headers: privateResponseHeaders },
    );
  try {
    const target = new URL(`/${path.join("/")}`, upstreamUrl("indexer"));
    target.search = request.nextUrl.search;
    const response = await fetch(target, {
      cache: "no-store",
      // workerd does not implement redirect: "error". Reject redirects explicitly.
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Indexer redirects are not permitted");
    }
    const headers = new Headers({ ...privateResponseHeaders, "content-type": "application/json" });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return new Response(response.body, {
      headers,
      status: response.status,
    });
  } catch (error) {
    logger.error("indexer.upstream.unavailable", { method: request.method, error });
    return Response.json(
      { error: "indexer-unavailable" },
      { status: 503, headers: privateResponseHeaders },
    );
  }
}
