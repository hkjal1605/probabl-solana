import { loadEnvConfig } from "@next/env";
import { getAddress } from "viem";

type Environment = Record<string, string | undefined>;

// Offline configuration checks only. Never print settings (URLs can contain keys).
export function validateCloudflareEnvironment(env: Environment): string[] {
  const errors: string[] = [];
  for (const key of [
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_ROBINHOOD_RPC_URL",
    "NEXT_PUBLIC_BLOCK_EXPLORER_URL",
    "NEXT_PUBLIC_POLYMARKET_STREAM_URL",
  ]) {
    const value = env[key];
    const protocol = key === "NEXT_PUBLIC_POLYMARKET_STREAM_URL" ? "wss:" : "https:";
    try {
      const url = new URL(value ?? "");
      const hostname = url.hostname;
      if (
        url.protocol !== protocol ||
        url.username ||
        url.password ||
        url.hash ||
        !hostname.includes(".") ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        /(^|\.)(example\.(com|org|net)|example|invalid|test)$/.test(hostname) ||
        /^[\d.]+$/.test(hostname) ||
        hostname.startsWith("[") ||
        ((key === "NEXT_PUBLIC_APP_URL" || key === "NEXT_PUBLIC_POLYMARKET_STREAM_URL") &&
          (url.pathname !== "/" || url.search))
      )
        throw new Error("invalid");
    } catch {
      errors.push(`${key} must be a real public ${protocol.slice(0, -1).toUpperCase()} URL`);
    }
  }
  const chainId = Number(env.NEXT_PUBLIC_ROBINHOOD_CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || chainId === 31337)
    errors.push("NEXT_PUBLIC_ROBINHOOD_CHAIN_ID must explicitly select the deployed chain");
  if (!env.NEXT_PUBLIC_ROBINHOOD_CHAIN_NAME?.trim())
    errors.push("NEXT_PUBLIC_ROBINHOOD_CHAIN_NAME is required");
  for (const key of [
    "NEXT_PUBLIC_CONDITIONAL_TOKENS_ADDRESS",
    "NEXT_PUBLIC_EXCHANGE_ADDRESS",
    "NEXT_PUBLIC_ATOMIC_ORDER_ROUTER_ADDRESS",
    "NEXT_PUBLIC_PAYOUT_VAULT_ADDRESS",
    "NEXT_PUBLIC_POSITION_ROUTER_ADDRESS",
  ]) {
    try {
      if (BigInt(getAddress(env[key] ?? "")) === 0n) throw new Error("zero");
    } catch {
      errors.push(`${key} must be a valid nonzero deployed contract address`);
    }
  }
  if (
    env.NEXT_PUBLIC_LOG_LEVEL &&
    !["debug", "info", "warn", "error", "silent"].includes(env.NEXT_PUBLIC_LOG_LEVEL)
  )
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
    console.info(
      "Public build configuration passed. Configure runtime API_URL and INDEXER_URL separately in Cloudflare.",
    );
  }
}
