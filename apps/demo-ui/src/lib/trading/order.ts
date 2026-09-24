import {
  assertMarketUnits,
  formatTokenAmount,
  type MarketUnits,
  parsePriceRawX18,
  parseTokenAmount,
  quoteForExecution,
  quoteForReservation,
} from "@conditional-stocks/domain";
import type { OrderIntent } from "@/protocol/engine";

export interface OrderFormValues extends MarketUnits {
  baseStep?: string;
  branch: "YES" | "NO";
  funding: "whole" | "claim";
  marketId: string;
  maxFeeBps?: number;
  price: string;
  quantity: string;
  side: "buy" | "sell";
  tif: "gtc" | "ioc";
}

export const previewOrder = (
  quantity: string,
  price: string,
  units: MarketUnits & { baseStep?: string },
) => {
  try {
    assertMarketUnits(units);
    const quantityRaw = parseTokenAmount(quantity, units.baseTokenDecimals);
    const priceRawX18 = parsePriceRawX18(price, units);
    if (quantityRaw <= 0n || quantityRaw >= 1n << 64n) throw new Error("invalid quantity");
    if (
      units.baseStep !== undefined &&
      (BigInt(units.baseStep) <= 0n || quantityRaw % BigInt(units.baseStep) !== 0n)
    )
      throw new Error("invalid quantity step");
    if (quoteForExecution(quantityRaw, priceRawX18) === 0n)
      throw new Error("Order notional is below one raw quote unit.");
    const reservationRaw = quoteForReservation(quantityRaw, priceRawX18);
    if (reservationRaw >= 1n << 64n) throw new Error("Quote exceeds SPL token range");
    return {
      cost: Number(formatTokenAmount(reservationRaw, units.quoteTokenDecimals)),
      costRaw: reservationRaw.toString(),
      priceRawX18: priceRawX18.toString(),
      qty: Number(formatTokenAmount(quantityRaw, units.baseTokenDecimals)),
      quantityRaw: quantityRaw.toString(),
      valid: true as const,
    };
  } catch {
    return {
      cost: 0,
      costRaw: "0",
      priceRawX18: "0",
      qty: 0,
      quantityRaw: "0",
      valid: false as const,
    };
  }
};

export const createOrder = (values: OrderFormValues): OrderIntent => {
  const preview = previewOrder(values.quantity, values.price, values);
  if (!preview.valid) throw new Error("Quantity and price must be positive decimal values.");
  const maxFeeBps = values.maxFeeBps ?? 0;
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 1_000)
    throw new Error("Maximum fee must be an integer from 0 to 1000 bps.");
  return {
    marketId: values.marketId,
    branch: values.branch,
    side: values.side,
    tif: values.tif,
    funding: values.funding,
    quantityRaw: preview.quantityRaw,
    limitPriceRawX18: preview.priceRawX18,
    maxFeeBps,
  };
};
