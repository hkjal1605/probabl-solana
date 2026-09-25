import { SOLANA_API_ORIGIN } from "@conditional-stocks/shared/endpoints";
import {
  expireSpotPrice,
  isSolanaMint,
  SOLANA_MAINNET_GENESIS,
  SPOT_BATCH_SIZE,
  type SpotPrice,
  type SpotPricesResponse,
  spotMapping,
} from "@conditional-stocks/shared/spot-prices";
import { multiplierValue } from "@conditional-stocks/solana-client";
import type { MarketLegView, MarketView } from "../types/api";

export function spotPricesUrl(mints: string[], base = SOLANA_API_ORIGIN): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Invalid spot API origin");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Spot API must be an HTTPS origin (HTTP allowed only for localhost)");
  if (!mints.length || mints.length > SPOT_BATCH_SIZE || mints.some((mint) => !isSolanaMint(mint)))
    throw new Error("Invalid spot mint request");
  const target = new URL("/v1/spot-prices", url);
  target.searchParams.set("mints", [...new Set(mints)].sort().join(","));
  return target.toString();
}

export function parseSpotPricesResponse(
  input: unknown,
  genesisHash: string,
  mints: string[],
  nowMs = Date.now(),
): SpotPricesResponse {
  const response = input as Partial<SpotPricesResponse> | null;
  const mappings = new Map(mints.map((mint) => [mint, spotMapping(genesisHash, mint)]));
  if (
    !response ||
    response.source !== "jupiter" ||
    response.sourceGenesisHash !== SOLANA_MAINNET_GENESIS ||
    response.displayOnly !== true ||
    response.genesisHash !== genesisHash ||
    !Number.isSafeInteger(response.asOf) ||
    response.asOf! <= 0 ||
    response.asOf! > Math.floor(nowMs / 1000) + 5 ||
    !Array.isArray(response.prices) ||
    response.prices.length !== mappings.size
  )
    throw new Error("Invalid spot response identity");
  const seen = new Set<string>();
  for (const price of response.prices) {
    const mapping = price && mappings.get(price.mint);
    if (
      !mapping ||
      seen.has(price.mint) ||
      price.sourceMint !== mapping.sourceMint ||
      price.referenceSymbol !== mapping.referenceSymbol ||
      price.testAsset !== mapping.testAsset ||
      price.valuationCompatible !== mapping.valuationCompatible ||
      ![
        "available",
        "stale",
        "age-unverified",
        "unavailable",
        "restricted",
        "invalid",
        "not-configured",
        "unmapped",
      ].includes(price.status) ||
      (mapping.sourceMint === null) !== (price.status === "unmapped")
    )
      throw new Error("Invalid spot mint mapping");
    seen.add(price.mint);
    const hasPrice = price.priceUsd !== null;
    if (
      hasPrice !== (price.blockId !== null) ||
      hasPrice !== (price.fetchedAt !== null) ||
      hasPrice !== (price.sourceDecimals !== null) ||
      (!hasPrice && price.priceTimestamp !== null)
    )
      throw new Error("Incomplete spot price");
    if (hasPrice) {
      if (
        ["invalid", "not-configured", "unmapped"].includes(price.status) ||
        typeof price.priceUsd !== "number" ||
        !Number.isFinite(price.priceUsd) ||
        price.priceUsd <= 0 ||
        !Number.isSafeInteger(price.blockId) ||
        price.blockId! <= 0 ||
        !Number.isInteger(price.sourceDecimals) ||
        price.sourceDecimals! < 0 ||
        price.sourceDecimals! > 255 ||
        !Number.isSafeInteger(price.fetchedAt) ||
        price.fetchedAt! <= 0 ||
        price.fetchedAt! > response.asOf! ||
        (price.priceTimestamp !== null &&
          (!Number.isSafeInteger(price.priceTimestamp) ||
            price.priceTimestamp <= 0 ||
            price.priceTimestamp > response.asOf! + 5)) ||
        (price.status === "available" && price.priceTimestamp === null)
      )
        throw new Error("Invalid spot price value");
    } else if (["available", "stale", "age-unverified"].includes(price.status))
      throw new Error("Missing spot price");
  }
  return {
    source: "jupiter",
    sourceGenesisHash: SOLANA_MAINNET_GENESIS,
    displayOnly: true,
    genesisHash,
    asOf: response.asOf!,
    prices: response.prices.map((price) => expireSpotPrice(price, nowMs)),
  };
}

/** Public, direct backend request: no Next route, provider key, wallet token or cookies. */
export async function fetchSpotPrices(
  genesisHash: string,
  mints: string[],
  options: { base?: string; signal?: AbortSignal } = {},
): Promise<SpotPricesResponse> {
  const timeout = AbortSignal.timeout(8000);
  const response = await fetch(spotPricesUrl(mints, options.base), {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Spot prices unavailable (${response.status})`);
  }
  return parseSpotPricesResponse(await response.json(), genesisHash, mints);
}

/** A leg's token price expressed per share of the underlying asset. */
function perShare(leg: MarketLegView): SpotPrice | undefined {
  const price = leg.spotReference;
  if (!price || price.priceUsd === null) return price;
  let multiplier = leg.live?.multiplierValue;
  if (multiplier === undefined)
    try {
      multiplier = multiplierValue(BigInt(leg.listingMultiplier));
    } catch {
      multiplier = undefined;
    }
  return multiplier && Number.isFinite(multiplier) && multiplier > 0
    ? { ...price, priceUsd: price.priceUsd / multiplier }
    : price;
}

export function withMarketSpotPrices(
  markets: MarketView[],
  response: SpotPricesResponse | undefined,
  nowMs = Date.now(),
  disconnected = false,
): MarketView[] {
  const prices = response && new Map(response.prices.map((price) => [price.mint, price]));
  const current = (price: SpotPrice | undefined) =>
    price
      ? disconnected
        ? { ...price, status: "unavailable" as const }
        : expireSpotPrice(price, nowMs)
      : undefined;
  return markets.map((market) => {
    const bases: MarketLegView[] = market.bases.map((leg) => {
      const spot = current(prices ? prices.get(leg.mint) : leg.spotReference);
      const { spotReference: _leg, ...rest } = leg;
      return spot ? { ...rest, spotReference: spot } : rest;
    });
    // The asset reference is the first listed leg with a price (the book's and
    // the market maker's reference leg), per share: the book trades shares, and a
    // leg token is `multiplier` shares (e.g. 5 for a split-adjusted pre-IPO token).
    const reference = [...bases]
      .sort((a, b) => a.collateral - b.collateral)
      .find((leg) => leg.spotReference && leg.spotReference.priceUsd !== null);
    const spotReference = prices ? reference && perShare(reference) : current(market.spotReference);
    const quoteSpotReference = current(
      prices ? prices.get(market.quoteToken) : market.quoteSpotReference,
    );
    const { spotReference: _base, quoteSpotReference: _quote, ...rest } = market;
    return {
      ...rest,
      bases,
      ...(spotReference ? { spotReference } : {}),
      ...(quoteSpotReference ? { quoteSpotReference } : {}),
      // Never carry an unverified old numeric reference through as a live price.
      ordinaryReference: spotReference?.status === "available" ? spotReference.priceUsd : null,
    };
  });
}
