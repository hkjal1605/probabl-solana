// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { ProtocolConstants } from "./ProtocolConstants.sol";

/// @notice All quantities and quote amounts are native token units, never whole-token amounts.
/// @dev priceRawX18 = raw quote units per raw base unit * 1e18. No decimals() dependency.
library PriceMath {
    function quoteDown(
        uint256 quantity,
        uint256 priceRawX18
    ) internal pure returns (uint256) {
        return Math.mulDiv(quantity, priceRawX18, ProtocolConstants.WAD);
    }

    function quoteUp(
        uint256 quantity,
        uint256 priceRawX18
    ) internal pure returns (uint256) {
        return Math.mulDiv(quantity, priceRawX18, ProtocolConstants.WAD, Math.Rounding.Ceil);
    }
}
