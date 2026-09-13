// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Fees on raw received claim amounts, with fractional carry across fills of one order.
library FeeMath {
    uint16 internal constant BPS = 10_000;
    uint16 internal constant MAX_FEE_BPS = 1_000;

    error InvalidFeeParameters();

    /// @dev Equivalent to divmod(gross * rate + carry, BPS), without overflowing the product.
    ///      Rates can change between fills; earlier fills are never repriced. Rounding favors
    ///      the user by less than one raw claim unit over the entire order, not per fill.
    function calculate(
        uint256 gross,
        uint16 rate,
        uint16 carry
    ) internal pure returns (uint256 fee, uint16 remainder) {
        if (rate > MAX_FEE_BPS || carry >= BPS) revert InvalidFeeParameters();
        uint256 fractional = mulmod(gross, rate, BPS) + carry;
        fee = Math.mulDiv(gross, rate, BPS) + fractional / BPS;
        // The modulus is below 10,000, strictly inside uint16.
        // forge-lint: disable-next-line(unsafe-typecast)
        remainder = uint16(fractional % BPS);
    }
}
