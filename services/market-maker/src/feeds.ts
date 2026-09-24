import {
  SOLANA_DEVNET_GENESIS,
  SOLANA_MAINNET_GENESIS,
  type SpotPricesResponse,
  spotMapping,
} from "@conditional-stocks/shared/spot-prices";
import {
  hex,
  multiplierParts,
  type MarketAccount,
  WAD,
} from "@conditional-stocks/solana-client";
import {
  BPS,
  decimal,
  type MarketPolicy,
  PROB,
  referenceMints,
  type Settings,
} from "./config.ts";
import type { Legs, Reference } from "./strategy.ts";

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
  legs: Legs,
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
  const response = prices as SpotPricesResponse,
    references = referenceMints(policy),
    mints = [...references, policy.quoteMint];
  if (
    !response ||
    response.source !== "jupiter" ||
    response.genesisHash !== genesis ||
    response.sourceGenesisHash !== SOLANA_MAINNET_GENESIS ||
    !Array.isArray(response.prices) ||
    response.prices.length !== mints.length ||
    policy.baseMints.length !== market.bases
  )
    throw new Error("Invalid reference price identity");
  times.push(fresh(response.asOf * 1000, now, s.maxFeedAgeMs));
  /** USD per raw token / 10^decimals, x 1e18, or null when the observation is
   * unusable. A substituted or duplicated identity always fails closed. */
  const observe = (mint: string, multiplier: string): { value: bigint; at: number[] } | null => {
    const rows = response.prices.filter((v) => v.mint === mint),
      mapping = spotMapping(genesis, mint),
      price = rows[0];
    if (
      rows.length !== 1 ||
      !price ||
      !mapping.sourceMint ||
      price.sourceMint !== mapping.sourceMint
    )
      throw new Error("Unusable spot price identity");
    const statusAccepted =
      price.status === "available" ||
      (price.status === "stale" && s.allowStaleDevnetSpot && genesis === SOLANA_DEVNET_GENESIS);
    if (
      !statusAccepted ||
      typeof price.priceUsd !== "number" ||
      !Number.isFinite(price.priceUsd) ||
      price.priceUsd <= 0 ||
      !Number.isSafeInteger(price.blockId) ||
      price.blockId! <= 0
    )
      return null;
    const ms = (seconds: number | null) => (seconds === null ? null : seconds * 1000);
    let at: number[];
    try {
      at = [
        fresh(ms(price.priceTimestamp), now, s.maxFeedAgeMs),
        fresh(ms(price.fetchedAt), now, s.maxFeedAgeMs),
      ];
    } catch {
      return null;
    }
    // Operator-reviewed unit conversion is separate from display-only valuationCompatible.
    // No mutation to the UI price feed or claim that it is an execution/settlement oracle.
    const value = (decimal(String(price.priceUsd), 18) * decimal(multiplier, 18)) / WAD;
    return value > 0n ? { value, at } : null;
  };
  const shareDecimals = market.terms.share_decimals,
    quoteDecimals = market.decimals[0]!;
  if (
    !Number.isInteger(shareDecimals) ||
    shareDecimals < 0 ||
    shareDecimals > 18 ||
    quoteDecimals < 0 ||
    quoteDecimals > 18
  )
    throw new Error("Unsupported token units");
  const quoteUsd = observe(policy.quoteMint, policy.quotePriceMultiplier);
  if (!quoteUsd) throw new Error("Unusable quote spot price");
  times.push(...quoteUsd.at);
  // One book prices one economic share. Each tradable reference leg observes it
  // independently: issuer token price / live ScaledUiAmount multiplier (exact
  // rational division). Non-reference legs never affect the price or pause.
  const spots: Record<number, bigint> = {};
  for (let c = 1; c <= market.bases; c++) {
    if (!references.includes(policy.baseMints[c - 1]!)) continue;
    const observed = observe(policy.baseMints[c - 1]!, policy.basePriceMultipliers[c - 1]!),
      leg = legs[c];
    if (!observed || !leg?.tradable) continue;
    const { mantissa, shift } = multiplierParts(leg.multiplier);
    spots[c] =
      ((observed.value << shift) * WAD * 10n ** BigInt(quoteDecimals)) /
      (mantissa * quoteUsd.value * 10n ** BigInt(shareDecimals));
    if (spots[c]! <= 0n) throw new Error("Unsupported token units");
    times.push(...observed.at);
  }
  const values = Object.values(spots).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!values.length) throw new Error("No tradable reference leg has a usable spot price");
  const low = values[0]!,
    high = values[values.length - 1]!;
  if ((high - low) * BPS > low * BigInt(s.maxLegDispersionBps))
    throw new Error("Reference legs disagree on the share price");
  const middle = values.length >> 1,
    spot = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2n;
  return { spot, probability: p, spread, observedAt: Math.min(...times), legs: spots };
}
export async function fetchReference(
  origin: string,
  genesis: string,
  market: MarketAccount,
  policy: MarketPolicy,
  s: Settings,
  legs: Legs,
) {
  const mints = [...referenceMints(policy), policy.quoteMint].join(",");
  const [source, prices] = await Promise.all([
    json(`${origin}/v1/markets/${policy.market}/polymarket`),
    json(`${origin}/v1/spot-prices?mints=${mints}`),
  ]);
  return reference(source, prices, genesis, market, policy, s, legs);
}
