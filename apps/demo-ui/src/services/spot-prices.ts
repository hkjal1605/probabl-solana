import {
  expireSpotPrice,
  type SpotPrice,
  type SpotPricesResponse,
} from "@conditional-stocks/shared/spot-prices";
import { spotPrices } from "@/protocol/engine";
import type { MarketView } from "../types/api";

export async function fetchSpotPrices(
  _genesisHash: string,
  mints: string[],
): Promise<SpotPricesResponse> {
  return spotPrices(mints);
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
    const spotReference = current(prices ? prices.get(market.baseToken) : market.spotReference);
    const quoteSpotReference = current(
      prices ? prices.get(market.quoteToken) : market.quoteSpotReference,
    );
    const { spotReference: _base, quoteSpotReference: _quote, ...rest } = market;
    return {
      ...rest,
      ...(spotReference ? { spotReference } : {}),
      ...(quoteSpotReference ? { quoteSpotReference } : {}),
      ordinaryReference: spotReference?.status === "available" ? spotReference.priceUsd : null,
    };
  });
}
