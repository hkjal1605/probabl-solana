import { ApiError } from "../../services/protocol-api-service";

/** Retry read-only review once after an explicit authentication rejection. */
export async function reviewWithSession<T>(options: {
  token: string | null;
  request: (token?: string) => Promise<T>;
  authenticate: () => Promise<string>;
  assertCurrent: () => void;
}) {
  try {
    return await options.request(options.token ?? undefined);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    // requestJson invalidates the rejected session before throwing. Authentication
    // can reuse a newer session if this was a late response for an older token.
    options.assertCurrent();
    const token = await options.authenticate();
    options.assertCurrent();
    return options.request(token);
  }
}
