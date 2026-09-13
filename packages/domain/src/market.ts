import { encodeAbiParameters, keccak256 } from "viem";

import type { MarketIdentity } from "./types.ts";

export const computeMarketId = (market: MarketIdentity) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "uint32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [
        market.protocolVersion,
        market.robinhoodChainId,
        market.baseToken,
        market.quoteToken,
        market.polygonChainId,
        market.polymarketConditionId,
        market.polymarketYesIndex,
        market.polymarketNoIndex,
        market.tradingOpen,
        market.tradingCutoff,
        market.rulesHash,
      ],
    ),
  );
