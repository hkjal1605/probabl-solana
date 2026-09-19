import {
  SOLANA_DEVNET_GENESIS,
  SOLANA_MAINNET_GENESIS,
  type SpotPricesResponse,
  spotMapping,
} from "@conditional-stocks/shared/spot-prices";
import { hex, type MarketAccount, WAD } from "@conditional-stocks/solana-client";
import { decimal, type MarketPolicy, PROB, type Settings } from "./config.ts";
import type { Reference } from "./strategy.ts";

export function apiOrigin(input: string) {
  const url = new URL(input);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use an HTTPS API origin, or localhost for tests");
  return url.origin;
}
export async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Reference HTTP read failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing reference body");
  let size = 0,
    body = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512000) throw new Error("Reference response too large");
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
function fresh(value: unknown, now: number, maxAge: number): number {
  const at = typeof value === "string" && /^[0-9]{1,16}$/.test(value) ? Number(value) : value;
  if (
    typeof at !== "number" ||
    !Number.isSafeInteger(at) ||
    at <= 0 ||
    at > now + 5000 ||
    now - at > maxAge
  )
    throw new Error("Stale or invalid reference time");
  return at;
}
export function reference(
  input: unknown,
  prices: unknown,
  genesis: string,
  market: MarketAccount,
  policy: MarketPolicy,
  s: Settings,
  now = Date.now(),
): Reference {
  const source = input as {
    metadata?: {
      normalized?: {
        conditionId?: string;
        active?: boolean;
        closed?: boolean;
        outcomes?: { label: string; tokenId: string; indexSet: string }[];
      };
    };
    probability?: Record<string, unknown>;
  };
  const metadata = source?.metadata?.normalized,
    tick = source?.probability;
  const yes = metadata?.outcomes?.find((o) => o.label === "YES"),
    no = metadata?.outcomes?.find((o) => o.label === "NO");
  if (
    !metadata ||
    !tick ||
    metadata.conditionId !== hex(market.terms.condition) ||
    tick.conditionId !== metadata.conditionId ||
    !yes ||
    !no ||
    metadata.outcomes?.length !== 2 ||
    yes.tokenId === no.tokenId ||
    metadata.closed !== false ||
    metadata.active !== true ||
    tick.yesTokenId !== yes.tokenId ||
    yes.indexSet !== String(market.terms.yes_index) ||
    no.indexSet !== String(market.terms.no_index) ||
    tick.schemaVersion !== 1 ||
    tick.quality !== "valid" ||
    tick.isStale !== false
  )
    throw new Error("Invalid/illiquid probability or condition mapping");
  const integer = (v: unknown) => {
    if (typeof v !== "string" || !/^[0-9]{1,20}$/.test(v))
      throw new Error("Invalid probability value");
    return BigInt(v);
  };
  const p = integer(tick.midpointX6),
    bid = integer(tick.bestBidX6),
    ask = integer(tick.bestAskX6),
    spread = integer(tick.spreadX6);
  if (
    bid <= 0n ||
    ask >= PROB ||
    bid >= ask ||
    (bid + ask) / 2n !== p ||
    ask - bid !== spread ||
    spread > BigInt(s.maxProbabilitySpreadX6) ||
    p < BigInt(s.probabilityFloorX6) ||
    p > PROB - BigInt(s.probabilityFloorX6) ||
    integer(tick.standardNotionalX6) <= 0n ||
    integer(tick.bidDepthQuoteX6) < integer(tick.standardNotionalX6) ||
    integer(tick.askDepthQuoteX6) < integer(tick.standardNotionalX6)
  )
    throw new Error("Probability outside liquidity/risk limits");
  const times = [fresh(tick.observedAtMs, now, s.maxFeedAgeMs)];
  const response = prices as SpotPricesResponse;
  if (
    !response ||
    response.source !== "jupiter" ||
    response.genesisHash !== genesis ||
    response.sourceGenesisHash !== SOLANA_MAINNET_GENESIS ||
    !Array.isArray(response.prices) ||
    response.prices.length !== 2
  )
    throw new Error("Invalid reference price identity");
  times.push(fresh(response.asOf * 1000, now, s.maxFeedAgeMs));
  const values = [policy.baseMint, policy.quoteMint].map((mint, index) => {
    const rows = response.prices.filter((v) => v.mint === mint),
      mapping = spotMapping(genesis, mint);
    const price = rows[0];
    const statusAccepted =
      price?.status === "available" ||
      (price?.status === "stale" && s.allowStaleDevnetSpot && genesis === SOLANA_DEVNET_GENESIS);
    if (
      rows.length !== 1 ||
      !price ||
      !statusAccepted ||
      !mapping.sourceMint ||
      price.sourceMint !== mapping.sourceMint ||
      typeof price.priceUsd !== "number" ||
      !Number.isFinite(price.priceUsd) ||
      price.priceUsd <= 0 ||
      !Number.isSafeInteger(price.blockId) ||
      price.blockId! <= 0
    )
      throw new Error("Unusable spot price");
    times.push(
      fresh(
        price.priceTimestamp === null ? null : price.priceTimestamp * 1000,
        now,
        s.maxFeedAgeMs,
      ),
    );
    times.push(
      fresh(price.fetchedAt === null ? null : price.fetchedAt * 1000, now, s.maxFeedAgeMs),
    );
    // Operator-reviewed unit conversion is separate from display-only valuationCompatible.
    // No mutation to the UI price feed or claim that it is an execution/settlement oracle.
    const multiplier = decimal(
      index === 0 ? policy.basePriceMultiplier : policy.quotePriceMultiplier,
      18,
    );
    return (decimal(String(price.priceUsd), 18) * multiplier) / WAD;
  });
  if (values.some((v) => v <= 0n) || market.decimals.some((d) => d < 0 || d > 18))
    throw new Error("Unsupported token units");
  const spot =
    (values[0]! * WAD * 10n ** BigInt(market.decimals[1]!)) /
    (values[1]! * 10n ** BigInt(market.decimals[0]!));
  return { spot, probability: p, spread, observedAt: Math.min(...times) };
}
export async function fetchReference(
  origin: string,
  genesis: string,
  market: MarketAccount,
  policy: MarketPolicy,
  s: Settings,
) {
  const [source, prices] = await Promise.all([
    json(`${origin}/v1/markets/${policy.market}/polymarket`),
    json(`${origin}/v1/spot-prices?mints=${policy.baseMint},${policy.quoteMint}`),
  ]);
  return reference(source, prices, genesis, market, policy, s);
}
