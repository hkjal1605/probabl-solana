// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { FeeMath } from "../src/libraries/FeeMath.sol";
import { TestBase } from "./TestBase.sol";

contract FeeMathHarness {
    function calculate(
        uint256 gross,
        uint16 rate,
        uint16 carry
    ) external pure returns (uint256, uint16) {
        return FeeMath.calculate(gross, rate, carry);
    }
}

contract FeeMathTest is TestBase {
    FeeMathHarness private harness = new FeeMathHarness();

    function testZeroRateAmountAndDust() public pure {
        (uint256 fee, uint16 carry) = FeeMath.calculate(0, 1000, 9999);
        assertEq(fee, 0, "no amount no fee");
        assertEq(carry, 9999, "carry retained");
        (fee, carry) = FeeMath.calculate(type(uint256).max, 0, 9999);
        assertEq(fee, 0, "zero rate");
        assertEq(carry, 9999, "zero rate does not reset carry");
        (fee, carry) = FeeMath.calculate(1, 1, 0);
        assertEq(fee, 0, "no one-unit minimum fee");
        assertEq(carry, 1, "dust carried");
    }

    function testUint256MaximumDoesNotOverflowAndAllRatesMatchIndependentReference() public pure {
        uint256 gross = type(uint256).max;
        for (uint16 rate; rate <= 1000; ++rate) {
            (uint256 fee, uint16 carry) = FeeMath.calculate(gross, rate, 9999);
            // Exact quotient/remainder decomposition avoids overflowing the independent reference.
            // forge-lint: disable-next-line(divide-before-multiply)
            uint256 expected = (gross / 10000) * rate + ((gross % 10000) * rate + 9999) / 10000;
            assertEq(fee, expected, "full precision uint256 maximum");
            assertEq(carry, ((gross % 10000) * rate + 9999) % 10000, "full precision carry");
            assertTrue(fee <= gross, "fee cannot exceed proceeds");
        }
    }

    function testRejectsOutOfBoundsRateAndCarry() public {
        vm.expectRevert(FeeMath.InvalidFeeParameters.selector);
        harness.calculate(1, 1001, 0);
        vm.expectRevert(FeeMath.InvalidFeeParameters.selector);
        harness.calculate(1, type(uint16).max, 0);
        vm.expectRevert(FeeMath.InvalidFeeParameters.selector);
        harness.calculate(1, 0, 10000);
        vm.expectRevert(FeeMath.InvalidFeeParameters.selector);
        harness.calculate(1, 1000, type(uint16).max);
    }

    function testFuzzFullPrecision(
        uint256 gross,
        uint16 rateSeed,
        uint16 carrySeed
    ) public pure {
        uint16 rate = rateSeed % 1001;
        uint16 previous = carrySeed % 10000;
        (uint256 fee, uint16 carry) = FeeMath.calculate(gross, rate, previous);
        uint256 small = (gross % 10000) * rate + previous;
        // The separate remainder term restores all precision lost by the first division.
        // forge-lint: disable-next-line(divide-before-multiply)
        assertEq(fee, (gross / 10000) * rate + small / 10000, "quotient reference");
        assertEq(carry, small % 10000, "remainder reference");
        assertTrue(fee <= gross, "no underflow when deducting");
        assertTrue(carry < 10000, "bounded carry");
    }

    function testFuzzFragmentationIndependent(
        uint128 first,
        uint128 second,
        uint16 rateSeed
    ) public pure {
        uint16 rate = rateSeed % 1001;
        (uint256 fee1, uint16 carry1) = FeeMath.calculate(first, rate, 0);
        (uint256 fee2, uint16 carry2) = FeeMath.calculate(second, rate, carry1);
        (uint256 single, uint16 carry) = FeeMath.calculate(uint256(first) + second, rate, 0);
        assertEq(fee1 + fee2, single, "splitting fills neither inflates nor avoids fees");
        assertEq(carry2, carry, "same final carry");
    }

    function testFuzzChangingRatesNeverRepricePastFills(
        uint128 first,
        uint128 second,
        uint16 rate1Seed,
        uint16 rate2Seed
    ) public pure {
        uint16 rate1 = rate1Seed % 1001;
        uint16 rate2 = rate2Seed % 1001;
        (uint256 fee1, uint16 carry1) = FeeMath.calculate(first, rate1, 0);
        (uint256 fee2, uint16 carry2) = FeeMath.calculate(second, rate2, carry1);
        uint256 weighted = uint256(first) * rate1 + uint256(second) * rate2;
        assertEq(fee1 + fee2, weighted / 10000, "weighted rate reference");
        assertEq(carry2, weighted % 10000, "weighted carry reference");
    }
}
