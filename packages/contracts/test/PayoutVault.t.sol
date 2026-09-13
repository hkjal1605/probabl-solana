// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PayoutVault } from "../src/PayoutVault.sol";
import { IConditionalTokens } from "../src/interfaces/IConditionalTokens.sol";
import { Payout } from "../src/types/ProtocolTypes.sol";
import { ExpectedCtfReceiver } from "../src/utils/ExpectedCtfReceiver.sol";
import { MutableReceiver } from "./AdversarialReceivers.t.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { FeeOnTransferToken, MockERC20, NoReturnToken } from "./mocks/MockTokens.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Unit-test provider, deliberately not part of the deployable protocol.
contract PayoutProviderHarness is ERC1155Holder {
    PayoutVault public immutable vault;
    address public constant settlement = address(0);

    constructor(
        IConditionalTokens ctf
    ) {
        vault = new PayoutVault(ctf);
        ctf.setApprovalForAll(address(vault), true);
    }

    function fundClaim(
        uint256 id,
        uint256 amount
    ) external {
        vault.fundClaim(id, amount);
    }

    function fundWhole(
        address token,
        uint256 amount
    ) external {
        (bool success,) = token.call(abi.encodeCall(IERC20.approve, (address(vault), amount)));
        require(success, "APPROVAL");
        vault.fundWhole(token, amount);
    }

    function deliver(
        Payout[] calldata payouts
    ) external {
        vault.deliver(payouts);
    }
}

/// @dev Transfers first, then returns false, rejects a destination, or shortchanges it.
contract SelectivePayoutToken is MockERC20 {
    address public blocked;
    bool public falseAfterTransfer;
    bool public shortTransfer;
    constructor() MockERC20("Payout test", "PAYOUT") { }

    function behavior(
        address blocked_,
        bool false_,
        bool short_
    ) external {
        blocked = blocked_;
        falseAfterTransfer = false_;
        shortTransfer = short_;
    }

    function transfer(
        address to,
        uint256 amount
    ) public override returns (bool) {
        require(to != blocked, "BLOCKED");
        super.transfer(to, shortTransfer ? amount - 1 : amount);
        return !falseAfterTransfer;
    }
}

contract PayoutVaultTest is ProtocolFixture {
    PayoutProviderHarness private provider;
    PayoutVault private vault;
    MutableReceiver private receiver;

    function setUp() public override {
        super.setUp();
        provider = new PayoutProviderHarness(ctf);
        vault = provider.vault();
        receiver = new MutableReceiver(buyer);
        receiver.setBehavior(true, false);
    }

    function _claimFunding(
        uint256 amount
    ) private {
        _splitFor(buyer, stock, amount);
        vm.prank(buyer);
        ctf.safeTransferFrom(buyer, address(provider), market.stockYesPositionId, amount, "");
        provider.fundClaim(market.stockYesPositionId, amount);
    }

    function _payout(
        address beneficiary,
        address asset,
        uint256 id,
        uint256 amount
    ) private pure returns (Payout[] memory payouts) {
        payouts = new Payout[](1);
        payouts[0] = Payout(beneficiary, asset, id, amount);
    }

    function _defer(
        uint256 amount
    ) private {
        _claimFunding(amount);
        provider.deliver(
            _payout(address(receiver), address(ctf), market.stockYesPositionId, amount)
        );
    }

    function testOnlyFailedDeliveryCreatesCreditAndOnlyBeneficiaryCanWithdraw() public {
        _claimFunding(3e18);
        Payout[] memory payouts = new Payout[](2);
        payouts[0] = Payout(address(receiver), address(ctf), market.stockYesPositionId, 1e18);
        payouts[1] = Payout(seller, address(ctf), market.stockYesPositionId, 2e18);
        provider.deliver(payouts);
        assertEq(ctf.balanceOf(seller, market.stockYesPositionId), 2e18, "successful delivery");
        assertEq(
            vault.claimable(seller, address(ctf), market.stockYesPositionId),
            0,
            "no successful credit"
        );
        assertEq(
            vault.totalClaimable(address(ctf), market.stockYesPositionId), 1e18, "exact liabilities"
        );
        vm.prank(buyer);
        vm.expectRevert(PayoutVault.InsufficientCredit.selector);
        vault.withdraw(address(ctf), market.stockYesPositionId, 1, buyer);
        vm.expectRevert(PayoutVault.InsufficientCredit.selector);
        vault.withdraw(address(ctf), market.stockYesPositionId, 1, buyer); // protocol admin has no claim
        vm.prank(address(receiver));
        vault.withdraw(address(ctf), market.stockYesPositionId, 0.4e18, buyer);
        assertEq(
            vault.claimable(address(receiver), address(ctf), market.stockYesPositionId),
            0.6e18,
            "partial credit"
        );
        vm.prank(address(receiver));
        vault.withdraw(address(ctf), market.stockYesPositionId, 0.6e18, seller);
        assertEq(vault.totalClaimable(address(ctf), market.stockYesPositionId), 0, "no debt");
        assertEq(ctf.balanceOf(address(vault), market.stockYesPositionId), 0, "no residue");
        vm.prank(address(receiver));
        vm.expectRevert(PayoutVault.InsufficientCredit.selector);
        vault.withdraw(address(ctf), market.stockYesPositionId, 1, buyer);
    }

    function testMaximumPayoutBatchCreditsEveryRejectedLegWithoutSpendingPriorCredits() public {
        _defer(7);
        uint256 count = vault.MAX_PAYOUTS();
        _claimFunding(count);
        Payout[] memory payouts = new Payout[](count);
        for (uint256 i; i < count; ++i) {
            payouts[i] = Payout(address(receiver), address(ctf), market.stockYesPositionId, 1);
        }
        provider.deliver(payouts);
        assertEq(
            vault.totalClaimable(address(ctf), market.stockYesPositionId),
            count + 7,
            "all legs plus prior credit"
        );
        assertEq(
            vault.claimable(address(receiver), address(ctf), market.stockYesPositionId),
            count + 7,
            "exact beneficiary credit"
        );
        assertEq(
            ctf.balanceOf(address(vault), market.stockYesPositionId), count + 7, "complete backing"
        );
    }

    function testRejectedWithdrawalRestoresCreditAndReentryCannotSpendItTwice() public {
        _defer(2e18);
        vm.prank(address(receiver));
        vm.expectRevert();
        vault.withdraw(address(ctf), market.stockYesPositionId, 1e18, address(receiver));
        assertEq(
            vault.claimable(address(receiver), address(ctf), market.stockYesPositionId),
            2e18,
            "failed withdrawal restored"
        );
        receiver.setBehavior(false, false);
        receiver.setCallback(
            address(vault),
            abi.encodeCall(
                PayoutVault.withdraw, (address(ctf), market.stockYesPositionId, 1e18, buyer)
            )
        );
        vm.prank(address(receiver));
        vault.withdraw(address(ctf), market.stockYesPositionId, 1e18, address(receiver));
        assertTrue(!receiver.callbackSucceeded(), "withdrawal reentry blocked");
        assertEq(ctf.balanceOf(address(receiver), market.stockYesPositionId), 1e18, "exact payment");
        assertEq(
            vault.claimable(address(receiver), address(ctf), market.stockYesPositionId),
            1e18,
            "single debit"
        );
    }

    function testCreditedAssetsCannotFundAnotherPayoutOrCredit() public {
        _defer(1e18);
        vm.expectRevert(PayoutVault.InsufficientBacking.selector);
        provider.deliver(_payout(seller, address(ctf), market.stockYesPositionId, 1));
        vm.expectRevert(PayoutVault.InsufficientBacking.selector);
        provider.deliver(_payout(address(receiver), address(ctf), market.stockYesPositionId, 1));
        assertEq(
            vault.totalClaimable(address(ctf), market.stockYesPositionId),
            1e18,
            "existing debt unchanged"
        );
    }

    function testFalseAfterMovingERC20RevertsInnerTransferBeforeCreatingCredit() public {
        SelectivePayoutToken token = new SelectivePayoutToken();
        token.mint(address(provider), 100);
        provider.fundWhole(address(token), 100);
        token.behavior(address(0), true, false);
        provider.deliver(_payout(buyer, address(token), 0, 100));
        assertEq(token.balanceOf(buyer), 0, "false-return movement rolled back");
        assertEq(token.balanceOf(address(vault)), 100, "credit fully backed");
        assertEq(vault.claimable(buyer, address(token), 0), 100, "exact deferred whole token");
        token.behavior(address(0), false, false);
        vm.prank(buyer);
        vault.withdraw(address(token), 0, 100, seller);
        assertEq(token.balanceOf(seller), 100, "exact whole-token withdrawal");
    }

    function testBlockedERC20DestinationAndOutboundShortTransferAreIsolated() public {
        SelectivePayoutToken token = new SelectivePayoutToken();
        token.mint(address(provider), 200);
        provider.fundWhole(address(token), 200);
        token.behavior(buyer, false, false);
        provider.deliver(_payout(buyer, address(token), 0, 100));
        token.behavior(address(0), false, true);
        provider.deliver(_payout(seller, address(token), 0, 100));
        assertEq(token.balanceOf(seller), 0, "short transfer rolled back");
        assertEq(vault.claimable(buyer, address(token), 0), 100, "blocked credit");
        assertEq(vault.claimable(seller, address(token), 0), 100, "short credit");
        assertEq(token.balanceOf(address(vault)), 200, "all liabilities backed");
    }

    function testNoReturnERC20SupportedAndDeflationaryFundingRejected() public {
        NoReturnToken legacy = new NoReturnToken();
        legacy.mint(address(provider), 100);
        provider.fundWhole(address(legacy), 100);
        provider.deliver(_payout(buyer, address(legacy), 0, 100));
        assertEq(legacy.balanceOf(buyer), 100, "optional-return token paid");
        FeeOnTransferToken deflationary = new FeeOnTransferToken();
        deflationary.mint(address(provider), 100);
        vm.expectRevert(PayoutVault.UnsupportedTransfer.selector);
        provider.fundWhole(address(deflationary), 100);
        assertEq(deflationary.balanceOf(address(provider)), 100, "bad funding rolled back");
    }

    function testVaultEntryPointsRejectUnauthorizedCallsAndUnsolicitedClaims() public {
        vm.expectRevert(PayoutVault.Unauthorized.selector);
        vault.fundWhole(address(quote), 1);
        vm.expectRevert(PayoutVault.Unauthorized.selector);
        vault.fundClaim(market.stockYesPositionId, 1);
        vm.expectRevert(PayoutVault.Unauthorized.selector);
        vault.deliver(new Payout[](0));
        vm.expectRevert(PayoutVault.Unauthorized.selector);
        vault.attemptDelivery(Payout(buyer, address(quote), 0, 1));
        _splitFor(buyer, stock, 1e18);
        vm.prank(buyer);
        vm.expectRevert();
        ctf.safeTransferFrom(buyer, address(vault), market.stockYesPositionId, 1e18, "");
        vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
        vault.onERC1155Received(address(this), buyer, market.stockYesPositionId, 1, "");
    }

    function testInvalidPayoutsAndWithdrawalsAreRejected() public {
        _defer(1e18);
        vm.prank(address(receiver));
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        vault.withdraw(address(ctf), market.stockYesPositionId, 0, buyer);
        vm.prank(address(receiver));
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        vault.withdraw(address(ctf), market.stockYesPositionId, 1, address(0));
        vm.prank(address(receiver));
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        vault.withdraw(address(ctf), market.stockYesPositionId, 1, address(vault));
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        provider.deliver(new Payout[](194));
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        provider.deliver(_payout(address(0), address(ctf), market.stockYesPositionId, 1));
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        provider.deliver(_payout(buyer, address(quote), 1, 1));
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        provider.fundClaim(market.stockYesPositionId, 0);
        vm.expectRevert(PayoutVault.InvalidPayout.selector);
        vm.prank(address(provider));
        vault.fundWhole(address(ctf), 1);
        provider.deliver(new Payout[](1)); // zero slots are inert
    }

    function testInsufficientGasCannotManufactureDeferredCredits() public {
        _claimFunding(1e18);
        vm.expectRevert(PayoutVault.InsufficientDeliveryGas.selector);
        provider.deliver{ gas: 160_000 }(
            _payout(buyer, address(ctf), market.stockYesPositionId, 1e18)
        );
        assertEq(
            vault.claimable(buyer, address(ctf), market.stockYesPositionId),
            0,
            "no artificial credit"
        );
        assertEq(
            ctf.balanceOf(address(vault), market.stockYesPositionId), 1e18, "funding unchanged"
        );
    }

    function testFuzzPartialWithdrawalsConserveExactCredits(
        uint128 raw,
        uint128 portion
    ) public {
        uint256 amount = uint256(raw) % 100e18 + 1;
        uint256 first = uint256(portion) % amount + 1;
        _defer(amount);
        vm.prank(address(receiver));
        vault.withdraw(address(ctf), market.stockYesPositionId, first, buyer);
        assertEq(
            vault.claimable(address(receiver), address(ctf), market.stockYesPositionId),
            amount - first,
            "exact owner remainder"
        );
        assertEq(
            vault.totalClaimable(address(ctf), market.stockYesPositionId),
            amount - first,
            "exact liability remainder"
        );
        assertEq(
            ctf.balanceOf(address(vault), market.stockYesPositionId),
            amount - first,
            "exact collateral remainder"
        );
    }
}
