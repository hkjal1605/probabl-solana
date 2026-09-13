import type { NextRequest } from "next/server";
import { privateResponseHeaders, upstreamUrl } from "@/lib/api/upstream";
import { logger } from "@/lib/logger";

async function forward(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (path.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
    return Response.json(
      { error: "invalid-route" },
      { status: 400, headers: privateResponseHeaders },
    );
  if (path[0] === "admin")
    return Response.json(
      { error: "route-not-public" },
      { status: 404, headers: privateResponseHeaders },
    );
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
    const responseHeaders = new Headers({
      ...privateResponseHeaders,
      "content-type": response.headers.get("content-type") ?? "application/json",
    });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) responseHeaders.set("retry-after", retryAfter);
    const requestId = response.headers.get("x-request-id");
    if (requestId && /^[a-f0-9-]{36}$/i.test(requestId))
      responseHeaders.set("x-request-id", requestId);
    if (!response.ok)
      logger.warn("gateway.upstream.failed", {
        status: response.status,
        method: request.method,
        requestId: responseHeaders.get("x-request-id"),
      });
    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status,
    });
  } catch (error) {
    logger.error("gateway.upstream.unavailable", { method: request.method, error });
    return Response.json(
      {
        error: {
          code: "gateway-unavailable",
          message: "The protocol API is unavailable.",
          retryable: true,
        },
      },
      { status: 503, headers: privateResponseHeaders },
    );
  }
}

export const GET = forward;
export const POST = forward;
