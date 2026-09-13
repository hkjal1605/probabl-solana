// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IConditionalTokens } from "./IConditionalTokens.sol";
import { IMarketRegistry } from "./IMarketRegistry.sol";
import { IProtocolAccess } from "./IProtocolAccess.sol";

interface IManualResolutionController is IProtocolAccess {
    function CONTROLLER_VERSION() external view returns (uint32);

    function ctf() external view returns (IConditionalTokens);
    function registry() external view returns (IMarketRegistry);
}
