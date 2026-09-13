// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PriceMath } from "../src/libraries/PriceMath.sol";
import { ConditionalExchangeTest } from "./ConditionalExchange.t.sol";
import { MockERC20, SixDecimalToken } from "./mocks/MockTokens.sol";

/// @dev Runs the entire settlement/funding/IOC/cancellation suite again with stock18 / quote6.
contract RawUnitRatioTest is ConditionalExchangeTest {
    function _quoteUnit() internal pure override returns (uint256) {
        return 1e6;
    }

    function _newQuoteToken() internal override returns (MockERC20) {
        return new SixDecimalToken();
    }

    function testRawRatioIsIndependentOfTokenMetadata() public view {
        assertEq(quote.decimals(), 6, "quote fixture decimals");
        assertEq(registry.PROTOCOL_VERSION(), 2, "protocol version");
        assertEq(PriceMath.quoteDown(1e18, 200e6), 200e6, "one stock costs 200 USDG");
        assertEq(PriceMath.quoteUp(1e18 + 1, 200e6), 200e6 + 1, "ceiling is one raw USDG unit");
    }
}
