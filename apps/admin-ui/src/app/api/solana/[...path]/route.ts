import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { fetchMetadataBySlug } from "@/lib/polymarket-metadata";
import { privateResponseHeaders, upstreamUrl } from "@/lib/upstream";

async function forward(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (path.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
    return Response.json(
      { error: "invalid-route" },
      { status: 400, headers: privateResponseHeaders },
    );
  if (request.method === "POST" && path.join("/") === "admin/polymarket/metadata/fetch-by-slug")
    return fetchMetadataBySlug(request);
  const headers = new Headers();
  for (const name of ["authorization", "content-type", "idempotency-key"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const target = new URL(`/v1/${path.join("/")}`, upstreamUrl("api"));
    target.search = request.nextUrl.search;
    const init: RequestInit & { duplex?: "half" } = {
      cache: "no-store",
      headers,
      method: request.method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }
    const response = await fetch(target, init);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Upstream redirects are not permitted");
    }
    const responseHeaders = new Headers({
      ...privateResponseHeaders,
      "content-type": response.headers.get("content-type") ?? "application/json",
    });
    const requestId = response.headers.get("x-request-id");
    if (requestId && /^[a-f0-9-]{36}$/i.test(requestId))
      responseHeaders.set("x-request-id", requestId);
    if (!response.ok)
      logger.warn("solana.upstream.failed", {
        status: response.status,
        method: request.method,
        requestId: responseHeaders.get("x-request-id"),
      });
    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status,
    });
  } catch (error) {
    logger.error("solana.upstream.unavailable", { method: request.method, error });
    return Response.json(
      { error: { code: "api-unavailable", message: "Admin API unavailable" } },
      { status: 503, headers: privateResponseHeaders },
    );
  }
}
export const GET = forward;
export const POST = forward;
