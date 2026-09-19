import {
  assertMarketUnits,
  formatTokenAmount,
  type MarketUnits,
  parsePriceRawX18,
  parseTokenAmount,
  quoteForExecution,
  quoteForReservation,
} from "@conditional-stocks/domain";
import { orderSalt } from "@conditional-stocks/solana-client";

export interface OrderFormValues extends MarketUnits {
  baseStep?: string;
  account: string;
  delegate?: string;
  delegateExpiresAt?: string;
  branch: "YES" | "NO";
  cutoff: string;
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

export const createOrder = (
  values: OrderFormValues,
  options: { nowMs?: number; salt?: `0x${string}` } = {},
) => {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffSeconds = Math.floor(new Date(values.cutoff).getTime() / 1_000);
  const preview = previewOrder(values.quantity, values.price, values);
  if (!preview.valid) throw new Error("Quantity and price must be positive decimal values.");
  if (!Number.isSafeInteger(cutoffSeconds)) throw new Error("Trading cutoff is invalid.");
  const maxFeeBps = values.maxFeeBps ?? 0;
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 1_000) {
    throw new Error("Maximum fee must be an integer from 0 to 1000 bps.");
  }
  return {
    maxFeeBps,
    branch: values.branch === "YES" ? 0 : 1,
    expiry: String(Math.min(Math.floor(nowMs / 1_000) + 30 * 86_400, cutoffSeconds - 1,
      values.delegateExpiresAt ? Number(values.delegateExpiresAt) - 1 : Number.MAX_SAFE_INTEGER)),
    fundingKind: values.funding === "whole" ? 0 : 1,
    limitPriceRawX18: preview.priceRawX18,
    maker: values.account,
    ...(values.delegate ? { delegate: values.delegate } : {}),
    marketId: values.marketId,
    nonce: String(nowMs),
    quantity: preview.quantityRaw,
    recipient: values.account,
    salt: options.salt ?? orderSalt(BigInt(nowMs), crypto.getRandomValues(new Uint8Array(32))),
    side: values.side === "buy" ? 0 : 1,
    tif: values.tif === "gtc" ? 0 : 1,
  };
};
