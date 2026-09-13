// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PayoutVault } from "../src/PayoutVault.sol";
import { Payout } from "../src/types/ProtocolTypes.sol";
import { MutableReceiver } from "./AdversarialReceivers.t.sol";
import { PayoutProviderHarness, SelectivePayoutToken } from "./PayoutVault.t.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { TestBase } from "./TestBase.sol";

/// @dev Independent ghost liabilities across two beneficiaries, ERC-20 and canonical ERC-1155.
contract PayoutStatefulHandler is ProtocolFixture {
    PayoutProviderHarness private provider;
    PayoutVault private vault;
    SelectivePayoutToken private token;
    MutableReceiver[2] private recipients;
    uint256[2][2] private credits;
    uint256 public deferred;
    uint256 public delivered;
    uint256 public withdrawn;

    constructor() {
        super.setUp();
        provider = new PayoutProviderHarness(ctf);
        vault = provider.vault();
        token = new SelectivePayoutToken();
        recipients[0] = new MutableReceiver(buyer);
        recipients[1] = new MutableReceiver(seller);
        pay(0, 10, true);
        pay(3, 20, true);
        pay(1, 30, false);
        withdrawCredit(0, 2, false);
    }

    function _asset(
        uint256 kind
    ) private view returns (address, uint256) {
        return kind == 0 ? (address(ctf), market.stockYesPositionId) : (address(token), 0);
    }

    function pay(
        uint256 seed,
        uint64 rawAmount,
        bool reject
    ) public {
        uint256 who = seed % 2;
        uint256 kind = (seed / 2) % 2;
        uint256 amount = uint256(rawAmount) % 1000 + 1;
        (address asset, uint256 id) = _asset(kind);
        address beneficiary = address(recipients[who]);
        if (kind == 0) {
            _splitFor(buyer, stock, amount);
            vm.prank(buyer);
            ctf.safeTransferFrom(buyer, address(provider), id, amount, "");
            provider.fundClaim(id, amount);
            recipients[who].setBehavior(reject, false);
        } else {
            token.behavior(address(0), false, false);
            token.mint(address(provider), amount);
            provider.fundWhole(address(token), amount);
            token.behavior(reject ? beneficiary : address(0), false, false);
        }
        Payout[] memory payouts = new Payout[](1);
        payouts[0] = Payout(beneficiary, asset, id, amount);
        provider.deliver(payouts);
        if (reject) {
            credits[who][kind] += amount;
            ++deferred;
        } else {
            ++delivered;
        }
    }

    function withdrawCredit(
        uint256 seed,
        uint64 requested,
        bool reject
    ) public {
        uint256 who = seed % 2;
        uint256 kind = (seed / 2) % 2;
        uint256 credit = credits[who][kind];
        if (credit == 0) return;
        uint256 amount = uint256(requested) % credit + 1;
        (address asset, uint256 id) = _asset(kind);
        recipients[who].setBehavior(true, false);
        token.behavior(reject ? buyer : address(0), false, false);
        address to = reject && kind == 0 ? address(recipients[who]) : buyer;
        vm.prank(address(recipients[who]));
        if (reject) vm.expectRevert();
        vault.withdraw(asset, id, amount, to);
        if (!reject) {
            credits[who][kind] -= amount;
            ++withdrawn;
        }
    }

    function unauthorized(
        uint256 seed
    ) public {
        (address asset, uint256 id) = _asset(seed % 2);
        vm.prank(secondBuyer);
        vm.expectRevert(PayoutVault.InsufficientCredit.selector);
        vault.withdraw(asset, id, 1, secondBuyer);
    }

    function assertBacking() public view {
        for (uint256 kind; kind < 2; ++kind) {
            (address asset, uint256 id) = _asset(kind);
            uint256 liability;
            for (uint256 who; who < 2; ++who) {
                assertEq(
                    vault.claimable(address(recipients[who]), asset, id),
                    credits[who][kind],
                    "independent beneficiary liability"
                );
                liability += credits[who][kind];
            }
            assertEq(vault.totalClaimable(asset, id), liability, "aggregate liability");
            uint256 backing =
                kind == 0 ? ctf.balanceOf(address(vault), id) : token.balanceOf(address(vault));
            assertEq(
                backing, liability, "exact backed credits, no double spending or lost accounting"
            );
        }
    }
}

contract PayoutInvariantsTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    PayoutStatefulHandler private handler;

    function setUp() public {
        handler = new PayoutStatefulHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.pay.selector;
        selectors[1] = handler.withdrawCredit.selector;
        selectors[2] = handler.unauthorized.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantPayoutCreditsAlwaysHaveExactBackingAndOwnership() public view {
        handler.assertBacking();
    }

    function testStatefulHandlerReachesSuccessFailureAndWithdrawals() public view {
        assertTrue(
            handler.delivered() > 0 && handler.deferred() > 0 && handler.withdrawn() > 0,
            "all economic paths reachable"
        );
        handler.assertBacking();
    }
}
