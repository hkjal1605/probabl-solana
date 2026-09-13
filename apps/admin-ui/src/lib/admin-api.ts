import type {
  CreationEvidencePacket,
  EvidenceEnvelope,
  ResolutionEvidencePacket,
} from "@conditional-stocks/solana-client/evidence";
export type { AdminPreview } from "@conditional-stocks/solana-client/admin";
import type { AdminPreview } from "@conditional-stocks/solana-client/admin";
import { logger } from "./logger";

export const SESSION_EXPIRED_EVENT = "probabl:admin-session-expired";
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (
    !/^\/api\/(?:gateway\/[A-Za-z0-9_/-]+|indexer\/[A-Za-z0-9_/-]+|health)$/.test(path) ||
    path.includes("//") ||
    path.includes("..")
  )
    throw new Error("Invalid same-origin API path");
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    logger.warn("admin.request.failed", {
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      method: init.method ?? "GET",
    });
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : `Request failed (${response.status})`;
    throw new AdminApiError(message, response.status);
  }
  if (!body || typeof body !== "object") throw new Error("API returned an invalid JSON response");
  return body as T;
}

export async function adminRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!token) throw new AdminApiError("Sign in with an operator wallet first", 401);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  try {
    return await requestJson<T>(`/api/gateway/${path}`, { ...init, headers });
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401 && typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: token }));
    throw error;
  }
}

export interface EvidenceView {
  envelope: EvidenceEnvelope<CreationEvidencePacket | ResolutionEvidencePacket>;
  observations: Array<{ action: string; observedAt: string; transactionHash: string }>;
  previews: AdminPreview[];
  reviews: Array<{ decision: string; reviewedAt: string; reviewer: string }>;
  status: "approved" | "prepared" | "rejected";
}
