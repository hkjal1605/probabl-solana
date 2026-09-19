import { MarketDataError } from "@conditional-stocks/market-data";

export interface PolymarketEnvironment {
  clobUrl: string;
  gammaUrl: string;
  host: string;
  internalToken: string;
  metadataPollMs: number;
  port: number;
  reconcileMs: number;
  staleAfterMs: bigint;
  standardNotionalX6: bigint;
  websocketUrl: string;
}

const positiveInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): number => {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MarketDataError("INVALID_CONFIG", `${name} must be a positive integer`);
  }
  return value;
};

const url = (environment: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const value = environment[name] ?? fallback;
  const parsed = new URL(value);
  if (!new Set(["http:", "https:", "ws:", "wss:"]).has(parsed.protocol)) {
    throw new MarketDataError("INVALID_CONFIG", `${name} has an invalid protocol`);
  }
  return parsed.toString().replace(/\/$/, "");
};

export const loadPolymarketEnvironment = (
  environment: NodeJS.ProcessEnv,
): PolymarketEnvironment => {
  const internalToken = environment.POLYMARKET_INTERNAL_TOKEN;
  if (!internalToken || internalToken.length < 16) {
    throw new MarketDataError(
      "INVALID_CONFIG",
      "POLYMARKET_INTERNAL_TOKEN must contain at least 16 characters",
    );
  }
  const standardNotionalX6 = BigInt(environment.POLYMARKET_STANDARD_NOTIONAL_X6 ?? "100000000");
  const reconcileMs = positiveInteger(environment, "POLYMARKET_RECONCILE_MS", "30000");
  const staleAfterMs = BigInt(environment.POLYMARKET_STALE_AFTER_MS ?? "90000");
  if (standardNotionalX6 <= 0n || staleAfterMs <= 0n) {
    throw new MarketDataError("INVALID_CONFIG", "probability thresholds must be positive");
  }
  if (staleAfterMs < BigInt(reconcileMs) * 2n)
    throw new MarketDataError(
      "INVALID_CONFIG",
      "POLYMARKET_STALE_AFTER_MS must cover at least two reconciliation intervals",
    );
  return {
    clobUrl: url(environment, "POLYMARKET_CLOB_URL", "https://clob.polymarket.com"),
    gammaUrl: url(environment, "POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com"),
    host: environment.POLYMARKET_HOST ?? "127.0.0.1",
    internalToken,
    metadataPollMs: positiveInteger(environment, "POLYMARKET_METADATA_POLL_MS", "300000"),
    port: positiveInteger(environment, "POLYMARKET_PORT", "42073"),
    reconcileMs,
    staleAfterMs,
    standardNotionalX6,
    websocketUrl: url(
      environment,
      "POLYMARKET_WS_URL",
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    ),
  };
};
