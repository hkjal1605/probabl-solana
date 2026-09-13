// Only import from server components or route handlers. Unlike NEXT_PUBLIC_*
// configuration, these values are read at request time from Worker/Node env.
import { SOLANA_API_ORIGIN } from "@conditional-stocks/shared/endpoints";

export function upstreamUrl(service: "api" | "indexer"): string {
  const key = service === "api" ? "API_URL" : "INDEXER_URL";
  const value = process.env[key];
  const onCloudflare = process.env.PROBABL_HOSTING === "cloudflare";
  if (!value && onCloudflare)
    throw new Error(`${key} is required on Cloudflare Workers`);
  let url: URL;
  try {
    url = new URL(value ?? SOLANA_API_ORIGIN);
  } catch {
    // URL parser errors can contain the invalid input; do not log credentials.
    throw new Error(`${key} must be a valid origin`);
  }
  if (
    !(onCloudflare
      ? url.protocol === "https:"
      : ["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      `${key} must be an ${onCloudflare ? "HTTPS" : "HTTP(S)"} origin`,
    );
  return url.origin;
}

export const privateResponseHeaders = {
  "cache-control": "private, no-store",
} as const;
