import type { MiddlewareHandler } from "hono";
import type { Logger } from "./logger.ts";

export interface RequestLoggingOptions {
  /** Health polling stays available at debug level; public API defaults log every request. */
  quietPaths?: readonly string[];
  /** Known Bun upgrade handlers return a placeholder 200 after accepting a 101 handshake. */
  websocketRoutes?: readonly string[];
}

/** Do not read bodies or log URL queries/headers. Logs handled errors too (Hono sets context.error). */
export function requestLogging(
  logger: Logger,
  options: RequestLoggingOptions = {},
): MiddlewareHandler {
  return async (context, next) => {
    // Mint a correlation ID instead of trusting an arbitrary caller-controlled header.
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const requestLogger = logger.child({ requestId, method: context.req.method });
    context.set("requestLogger", requestLogger);
    context.set("requestId", requestId);
    const upgrade = context.req.header("upgrade")?.toLowerCase() === "websocket";
    // Mutating upgrade response headers can break Bun WebSocket handshakes.
    if (!upgrade) context.header("x-request-id", requestId);
    let thrown: unknown;
    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      // Handlers may return a standalone Response (including onError responses),
      // replacing the headers prepared before next(). Attach correlation there too.
      if (!upgrade && context.finalized) context.header("x-request-id", requestId);
      const error = thrown ?? context.error;
      const handlerStatus = context.finalized ? context.res.status : error ? 500 : 404;
      const status =
        upgrade &&
        !error &&
        handlerStatus === 200 &&
        options.websocketRoutes?.includes(context.req.routePath)
          ? 101
          : handlerStatus;
      const fields = {
        // Matched template rather than user-supplied path segments; no tokens in URLs.
        route: context.req.routePath ?? "unmatched",
        status,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        ...(error ? { error } : {}),
      };
      if (status >= 500) requestLogger.error("http.request.completed", fields);
      else if (error || status >= 400) requestLogger.warn("http.request.completed", fields);
      else if (
        options.quietPaths?.includes(context.req.path) ||
        options.quietPaths?.includes(context.req.routePath)
      )
        requestLogger.debug("http.request.completed", fields);
      else requestLogger.info("http.request.completed", fields);
    }
  };
}
