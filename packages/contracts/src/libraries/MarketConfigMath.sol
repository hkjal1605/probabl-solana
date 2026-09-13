// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PriceMath } from "./PriceMath.sol";
import { ProtocolConstants } from "./ProtocolConstants.sol";

/// @notice A constructive feasibility check: one base step at an aligned price must be openable.
library MarketConfigMath {
    /// @dev Inputs must be nonzero. ceil(step * tick * n / WAD) >= minimum iff
    ///      step * tick * n > (minimum - 1) * WAD. All intermediate values fit uint256.
    ///      The caller must also check that the returned price fits uint128.
    function minimumOrderAtBaseStep(
        uint128 baseStep,
        uint128 priceTickRawX18,
        uint128 minNotional
    ) internal pure returns (uint256 priceRawX18, uint256 notional) {
        uint256 ticks = (uint256(minNotional - 1) * ProtocolConstants.WAD)
            / (uint256(baseStep) * priceTickRawX18) + 1;
        priceRawX18 = ticks * priceTickRawX18;
        notional = PriceMath.quoteUp(baseStep, priceRawX18);
    }
}
