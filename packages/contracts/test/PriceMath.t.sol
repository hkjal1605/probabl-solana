// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PriceMath } from "../src/libraries/PriceMath.sol";
import { TestBase } from "./TestBase.sol";

contract PriceMathHarness {
    function quoteDown(
        uint256 quantity,
        uint256 priceRawX18
    ) external pure returns (uint256) {
        return PriceMath.quoteDown(quantity, priceRawX18);
    }

    function quoteUp(
        uint256 quantity,
        uint256 priceRawX18
    ) external pure returns (uint256) {
        return PriceMath.quoteUp(quantity, priceRawX18);
    }
}

contract PriceMathTest is TestBase {
    PriceMathHarness private harness;

    function setUp() public {
        harness = new PriceMathHarness();
    }

    function testFuzzReservationNeverRoundsBelowExecution(
        uint128 quantity,
        uint128 priceRawX18
    ) public view {
        uint256 down = harness.quoteDown(quantity, priceRawX18);
        uint256 up = harness.quoteUp(quantity, priceRawX18);
        assertTrue(up >= down, "reservation below execution");
        assertTrue(up - down <= 1, "rounding gap above one quote unit");
    }

    function testFuzzPartialReservationAlwaysCoversFill(
        uint128 rawQuantity,
        uint128 rawFill,
        uint128 rawLimit,
        uint128 rawExecution
    ) public view {
        uint256 quantity = uint256(rawQuantity) + 1;
        uint256 fill = uint256(rawFill) % (quantity + 1);
        uint256 limit = uint256(rawLimit) + 1;
        uint256 execution = uint256(rawExecution) % (limit + 1);

        uint256 oldReservation = harness.quoteUp(quantity, limit);
        uint256 executionDebit = harness.quoteDown(fill, execution);
        uint256 newReservation = harness.quoteUp(quantity - fill, limit);
        assertTrue(
            oldReservation >= executionDebit + newReservation, "partial fill undercollateralized"
        );
    }
}
