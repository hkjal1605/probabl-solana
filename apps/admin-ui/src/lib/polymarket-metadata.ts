// Server-side adapter: the deployed API/ingestor continues to use canonical IDs.
import {
  MarketDataError,
  type NormalizedPolymarketMarket,
  normalizeGammaMarket,
} from "@conditional-stocks/market-data";
import { parseMarketSlug } from "./polymarket-slug";
import { privateResponseHeaders, upstreamUrl } from "./upstream";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
class MetadataError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function boundedJson(message: Request | Response, limit: number, status: number) {
  const tooLarge = () => new MetadataError("Polymarket metadata payload is too large", status);
  if (Number(message.headers.get("content-length") ?? "0") > limit) {
    await message.body?.cancel();
    throw tooLarge();
  }
  if (!message.body) throw new MetadataError("Missing JSON payload", status);
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new MetadataError("Invalid JSON payload", status);
  }
}

export async function resolvePolymarketSlug(
  input: unknown,
  signal?: AbortSignal,
): Promise<NormalizedPolymarketMarket> {
  const slug = parseMarketSlug(input);
  const response = await fetch(
    `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`,
    {
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
        : AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404)
      throw new MetadataError(
        "No Polymarket market matches that slug. For an event with multiple markets, use the individual market's slug.",
        404,
      );
    throw new MetadataError("Polymarket lookup is unavailable. Please try again.", 503);
  }
  let normalized: NormalizedPolymarketMarket;
  try {
    normalized = normalizeGammaMarket(await boundedJson(response, MAX_RESPONSE_BYTES, 502));
  } catch (error) {
    if (error instanceof MarketDataError)
      throw new MetadataError(error.message, error.code === "UNSUPPORTED_MARKET" ? 422 : 502);
    throw error;
  }
  if (normalized.slug !== slug || !/^[1-9][0-9]{0,255}$/.test(normalized.gammaMarketId))
    throw new MetadataError("Polymarket returned a different or invalid market identity", 502);
  return normalized;
}

export async function fetchMetadataBySlug(request: Request): Promise<Response> {
  const headers = new Headers(privateResponseHeaders);
  const fail = (message: string, status: number) =>
    Response.json({ error: { code: "polymarket-metadata", message } }, { status, headers });
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer \S+$/.test(authorization))
    return fail("Sign in with an operator wallet first", 401);
  // Presence is not authorization: the deployed API still verifies the session
  // and live operator roles before the ingestor may persist any snapshot.
  let slug: string;
  try {
    const body = await boundedJson(request, 2_048, 400);
    if (!record(body) || Object.keys(body).some((key) => key !== "marketSlug"))
      return fail("Provide only marketSlug for this lookup", 400);
    slug = parseMarketSlug(body.marketSlug);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid market slug", 400);
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]);
    const resolved = await resolvePolymarketSlug(slug, signal);
    // Never send the operator session to Gamma; it goes only to our configured API.
    // No automatic retries: the API creates an immutable metadata snapshot.
    const response = await fetch(
      new URL("/v1/admin/polymarket/metadata/fetch", upstreamUrl("api")),
      {
        method: "POST",
        body: JSON.stringify({ gammaMarketId: resolved.gammaMarketId }),
        headers: { authorization, "content-type": "application/json" },
        cache: "no-store",
        redirect: "error",
        signal,
      },
    );
    const requestId = response.headers.get("x-request-id");
    if (requestId && /^[a-f0-9-]{36}$/i.test(requestId)) headers.set("x-request-id", requestId);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new MetadataError("Admin API redirects are not permitted", 502);
    }
    const snapshot = await boundedJson(response, MAX_RESPONSE_BYTES, 502);
    if (!response.ok) return Response.json(snapshot, { status: response.status, headers });
    if (
      !record(snapshot) ||
      typeof snapshot.snapshotId !== "string" ||
      !snapshot.snapshotId ||
      !record(snapshot.normalized) ||
      snapshot.normalized.slug !== slug ||
      snapshot.normalized.gammaMarketId !== resolved.gammaMarketId ||
      snapshot.normalized.conditionId !== resolved.conditionId ||
      snapshot.normalized.mappingHash !== resolved.mappingHash
    )
      throw new MetadataError(
        "The saved metadata does not match the requested market. Fetch again before preparing evidence.",
        409,
      );
    // Only return the authoritative ingestor snapshot, never fabricate one from Gamma.
    return Response.json(snapshot, { headers });
  } catch (error) {
    return fail(
      error instanceof MetadataError
        ? error.message
        : "Unable to fetch Polymarket metadata. Please try again.",
      error instanceof MetadataError ? error.status : 503,
    );
  }
}
