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

/** Reads and mutations are served by the local protocol model. */
export async function requestJson<T>(): Promise<T> {
  throw new ApiError("Unsupported request", 400, null);
}
