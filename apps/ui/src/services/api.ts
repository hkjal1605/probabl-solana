import { assertRequestSession, SESSION_EXPIRED_EVENT } from "../lib/wallet/session";
import { apiUrl } from "./constants";
import { retryAfterMs } from "./read-policy";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Direct, origin-bound transport. Never retry mutations or log signed payloads. */
export async function requestJson<T>(
  path: string,
  options: { signal?: AbortSignal; token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new Error("Invalid API path");
  if (options.token && typeof window !== "undefined") {
    try {
      assertRequestSession(options.token);
    } catch {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: options.token }));
      throw new ApiError(
        "Your trading session expired or wallet changed. Sign in again.",
        401,
        null,
      );
    }
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const response = await fetch(apiUrl(path), {
    credentials: "omit",
    method: options.body === undefined ? "GET" : "POST",
    cache: "no-store",
    redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    if (response.status === 401 && options.token && typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: options.token }));
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    const message =
      error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : `Data unavailable (${response.status})`;
    throw new ApiError(
      message,
      response.status,
      response.headers.get("x-request-id"),
      retryAfterMs(response.headers.get("retry-after")),
    );
  }
  return response.json() as Promise<T>;
}
