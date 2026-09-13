// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Payout, SettlementFill } from "../types/ProtocolTypes.sol";
import { IConditionalTokens } from "./IConditionalTokens.sol";
import { IMarketRegistry } from "./IMarketRegistry.sol";

interface IConditionalSettlement {
    function conditionalTokens() external view returns (IConditionalTokens);
    function registry() external view returns (IMarketRegistry);
    function exchange() external view returns (address);
    function settleFill(
        SettlementFill calldata fill
    ) external returns (Payout[4] memory);
}
