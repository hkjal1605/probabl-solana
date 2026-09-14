import { cors } from "hono/cors";

/** Browser access uses the same exact origin allowlist as wallet authentication. */
export const browserCors = (origins: readonly string[]) =>
  cors({
    origin: (origin) => (origins.includes(origin) ? origin : undefined),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposeHeaders: ["Retry-After", "X-Request-Id"],
    maxAge: 3600,
  });
