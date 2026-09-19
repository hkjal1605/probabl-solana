import { loadEnvConfig } from "@next/env";
import { PublicKey } from "@solana/web3.js";

type Environment = Record<string, string | undefined>;

// Offline checks only. Never print URLs; RPC query parameters may contain credentials.
export function validateCloudflareEnvironment(env: Environment): string[] {
  const errors: string[] = [];
  for (const key of ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SOLANA_RPC_URL"]) {
    try {
      const url = new URL(env[key] ?? "");
      const hostname = url.hostname;
      if (
        url.protocol !== "https:" || url.username || url.password || url.hash ||
        !hostname.includes(".") || hostname === "localhost" ||
        hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
        /(^|\.)(example\.(com|org|net)|example|invalid|test)$/.test(hostname) ||
        /^[\d.]+$/.test(hostname) || hostname.startsWith("[") ||
        (key !== "NEXT_PUBLIC_SOLANA_RPC_URL" && (url.pathname !== "/" || url.search))
      ) throw new Error("invalid");
    } catch {
      errors.push(`${key} must be a public HTTPS URL`);
    }
  }
  for (const key of ["NEXT_PUBLIC_SOLANA_GENESIS_HASH", "NEXT_PUBLIC_SOLANA_PROGRAM_ID", "NEXT_PUBLIC_SOLANA_CONFIG"]) {
    try {
      const value = env[key] ?? "";
      if (!value || new PublicKey(value).toBase58() !== value || new PublicKey(value).equals(PublicKey.default))
        throw new Error("invalid");
    } catch {
      errors.push(`${key} must be a nonzero Solana public key`);
    }
  }
  if (env.NEXT_PUBLIC_LOG_LEVEL &&
    !["debug", "info", "warn", "error", "silent"].includes(env.NEXT_PUBLIC_LOG_LEVEL))
    errors.push("NEXT_PUBLIC_LOG_LEVEL is invalid");
  return errors;
}

if (import.meta.main) {
  loadEnvConfig(new URL("..", import.meta.url).pathname, false);
  const errors = validateCloudflareEnvironment(process.env);
  if (errors.length) {
    console.error(`Cloudflare deployment configuration is incomplete:\n${errors.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.info("Public Solana configuration passed. Configure runtime API_URL separately in Cloudflare.");
  }
}
