// Server routes only: never expose private service origins or database credentials to the browser.
import { SOLANA_API_ORIGIN } from "@conditional-stocks/shared/endpoints";

export const privateResponseHeaders = {
  "cache-control": "private, no-store",
} as const;
export function upstreamUrl(service: "api" | "indexer") {
  const key = service === "api" ? "API_URL" : "INDEXER_URL";
  return serviceOrigin(process.env[key] ?? SOLANA_API_ORIGIN, key);
}

export function serviceOrigin(value: string, key: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid service origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${key} must be an HTTP(S) origin without credentials`);
  return url.origin;
}
