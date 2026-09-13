// Server routes only: never expose private service origins or database credentials to the browser.
export const privateResponseHeaders = { "cache-control": "private, no-store" } as const;
export function upstreamUrl(service: "api" | "indexer") {
  const key = service === "api" ? "API_URL" : "INDEXER_URL";
  let url: URL;
  try {
    url = new URL(process.env[key] ?? `http://127.0.0.1:${service === "api" ? 3000 : 42069}`);
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
