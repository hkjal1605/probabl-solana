import { type Address, type Hex, hashTypedData } from "viem";

import type { Order } from "./types.ts";

export const ORDER_EIP712_NAME = "ConditionalExchange";
// Order signing version is independent of the v2 raw-unit market identity.
export const ORDER_EIP712_VERSION = "3";
export const MAX_FEE_BPS = 1_000;

export const orderTypes = {
  Order: [
    { name: "maker", type: "address" },
    { name: "recipient", type: "address" },
    { name: "marketId", type: "bytes32" },
    { name: "branch", type: "uint8" },
    { name: "side", type: "uint8" },
    { name: "fundingKind", type: "uint8" },
    { name: "quantity", type: "uint128" },
    { name: "limitPriceRawX18", type: "uint128" },
    { name: "tif", type: "uint8" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint64" },
    { name: "salt", type: "bytes32" },
    { name: "maxFeeBps", type: "uint16" },
  ],
} as const;

export interface OrderDomain {
  chainId: bigint;
  verifyingContract: Address;
}

export const orderTypedData = (order: Order, domain: OrderDomain) => ({
  domain: {
    chainId: domain.chainId,
    name: ORDER_EIP712_NAME,
    verifyingContract: domain.verifyingContract,
    version: ORDER_EIP712_VERSION,
  },
  message: order,
  primaryType: "Order" as const,
  types: orderTypes,
});

export const hashOrder = (order: Order, domain: OrderDomain): Hex =>
  hashTypedData(orderTypedData(order, domain));
