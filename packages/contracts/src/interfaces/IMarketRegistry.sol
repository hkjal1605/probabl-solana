// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Market, MarketState } from "../types/ProtocolTypes.sol";
import { IConditionalTokens } from "./IConditionalTokens.sol";
import { IProtocolAccess } from "./IProtocolAccess.sol";

interface IMarketRegistry is IProtocolAccess {
    function ctf() external view returns (IConditionalTokens);

    function resolutionCommitments(
        bytes32 marketId
    ) external view returns (bytes32);

    function getMarket(
        bytes32 marketId
    ) external view returns (Market memory market);

    function resolutionController() external view returns (address);

    function markResolved(
        bytes32 marketId
    ) external;

    function markRedeemable(
        bytes32 marketId
    ) external;

    function isTradingOpen(
        bytes32 marketId
    ) external view returns (bool);

    function marketState(
        bytes32 marketId
    ) external view returns (MarketState);
}
