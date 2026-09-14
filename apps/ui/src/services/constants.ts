import { SOLANA_API_ORIGIN } from "@conditional-stocks/shared/endpoints";

const configured = new URL(process.env.NEXT_PUBLIC_API_URL ?? SOLANA_API_ORIGIN);
if (
  (configured.protocol !== "https:" &&
    !(
      configured.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(configured.hostname)
    )) ||
  configured.username ||
  configured.password ||
  configured.pathname !== "/" ||
  configured.search ||
  configured.hash
)
  throw new Error("NEXT_PUBLIC_API_URL must be an HTTPS API origin (localhost HTTP is allowed).");
export const API_URL = configured.origin;
export const apiUrl = (path: string) => {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new Error("Invalid API path");
  const url = new URL(path, API_URL);
  if (url.origin !== API_URL) throw new Error("Foreign API origin");
  return url.toString();
};
