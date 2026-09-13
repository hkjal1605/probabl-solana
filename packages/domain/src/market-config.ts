import { quoteForExecution, quoteForReservation, WAD } from "./math.ts";

export interface MarketCapConfig {
  baseStep: bigint;
  priceTickRawX18: bigint;
  minNotional: bigint;
  maxOrderQuantity: bigint;
  maxOrderNotional: bigint;
  maxWalletOpenNotional: bigint;
  maxMarketOpenNotional: bigint;
}

/** Construct an executable pair at one base step, matching MarketRegistry's conservative rule. */
export const validateMarketCaps = (config: MarketCapConfig) => {
  const maximum = (1n << 128n) - 1n;
  const fields = [
    "baseStep",
    "priceTickRawX18",
    "minNotional",
    "maxOrderQuantity",
    "maxOrderNotional",
    "maxWalletOpenNotional",
    "maxMarketOpenNotional",
  ] as const;
  for (const name of fields) {
    const value = config[name];
    if (typeof value !== "bigint" || value <= 0n || value > maximum)
      throw new RangeError(`${name} must be a positive uint128`);
  }
  const { baseStep, priceTickRawX18, minNotional } = config;
  if (
    config.maxOrderQuantity < baseStep ||
    config.maxOrderNotional < minNotional ||
    config.maxWalletOpenNotional < config.maxOrderNotional ||
    config.maxMarketOpenNotional < config.maxWalletOpenNotional ||
    quoteForExecution(baseStep, priceTickRawX18) === 0n
  )
    throw new RangeError("Invalid market cap ordering or zero executable quote");
  const ticks = ((minNotional - 1n) * WAD) / (baseStep * priceTickRawX18) + 1n;
  const price = ticks * priceTickRawX18;
  const notional = quoteForReservation(baseStep, price);
  if (
    price > maximum ||
    notional > config.maxOrderNotional ||
    2n * notional > config.maxMarketOpenNotional
  )
    throw new RangeError("Caps must admit two aligned minimum orders at one base step");
  return { quantity: baseStep, priceRawX18: price, notional };
};
