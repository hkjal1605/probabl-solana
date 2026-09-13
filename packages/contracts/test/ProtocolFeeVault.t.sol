// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ConditionalSettlement } from "../src/ConditionalSettlement.sol";
import { ProtocolAuthority } from "../src/ProtocolAuthority.sol";
import { ProtocolFeeVault } from "../src/ProtocolFeeVault.sol";
import { IConditionalTokens } from "../src/interfaces/IConditionalTokens.sol";
import { IProtocolAuthority } from "../src/interfaces/IProtocolAuthority.sol";
import { Branch, FundingKind, Order, Side, TimeInForce } from "../src/types/ProtocolTypes.sol";
import { MutableReceiver } from "./AdversarialReceivers.t.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

contract FeeVaultReceiver is ERC1155Holder {
    ProtocolFeeVault public vault;
    bool public rejects;
    bool public reentered;
    bool public attemptsReentry;

    constructor(
        ProtocolFeeVault vault_
    ) {
        vault = vault_;
    }

    function configure(
        bool rejects_,
        bool attempts_
    ) external {
        rejects = rejects_;
        attemptsReentry = attempts_;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory
    ) public override returns (bytes4) {
        require(!rejects, "REJECT");
        if (attemptsReentry) {
            (reentered,) =
                address(vault).call(abi.encodeCall(vault.claimFees, (address(this), ids, values)));
        }
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }
}

contract ProtocolFeeVaultTest is ProtocolFixture {
    function _earn(
        address buyerRecipient
    ) private {
        feeVault.setFeeRates(100, 200);
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            0,
            keccak256("FEE_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            0,
            keccak256("FEE_ASK")
        );
        bid.maxFeeBps = 1000;
        ask.maxFeeBps = 1000;
        bid.recipient = buyerRecipient;
        _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, 1e18);
    }

    function _ids() private view returns (uint256[] memory ids, uint256[] memory amounts) {
        ids = new uint256[](2);
        amounts = new uint256[](2);
        ids[0] = market.stockYesPositionId;
        ids[1] = market.quoteYesPositionId;
        amounts[0] = 1e16;
        amounts[1] = 4e18;
    }

    function _transferAdmin(
        address next
    ) private {
        authority.beginDefaultAdminTransfer(next);
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(next);
        authority.acceptDefaultAdminTransfer();
    }

    function testZeroDefaultsAndOnlyDefaultAdminCanUpdateRatesOrClaim() public {
        (uint16 makerBps, uint16 takerBps) = feeVault.feeRates();
        assertEq(makerBps, 0, "maker defaults zero");
        assertEq(takerBps, 0, "taker defaults zero");
        vm.prank(buyer);
        vm.expectRevert();
        feeVault.setFeeRates(1, 2);
        (uint256[] memory ids, uint256[] memory amounts) = _ids();
        vm.prank(buyer);
        vm.expectRevert();
        feeVault.claimFees(buyer, ids, amounts);
        uint256[] memory sets = new uint256[](1);
        sets[0] = 1;
        vm.prank(buyer);
        vm.expectRevert();
        feeVault.redeemFees(stock, market.conditionId, sets, buyer);
        feeVault.setFeeRates(1000, 1000);
        vm.expectRevert(ProtocolFeeVault.FeeRateTooHigh.selector);
        feeVault.setFeeRates(1001, 0);
        vm.expectRevert(ProtocolFeeVault.FeeRateTooHigh.selector);
        feeVault.setFeeRates(0, type(uint16).max);
        assertEq(feeVault.makerFeeBps(), 1000, "invalid update atomic");
        feeVault.setFeeRates(0, 0);
        assertEq(feeVault.takerFeeBps(), 0, "admin can disable immediately");
    }

    function testClaimBeforeResolutionAndNoAuthorityOverEscrow() public {
        _earn(buyer);
        (uint256[] memory ids, uint256[] memory amounts) = _ids();
        // Keep an unrelated user's live reservation while the admin claims revenue.
        Order memory bid = _order(
            secondBuyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            2e18,
            200e18,
            TimeInForce.GTC,
            0,
            keccak256("LIVE_ESCROW")
        );
        _openOrder(bid, _sign(bid, SECOND_BUYER_KEY));
        uint256 escrow = quote.balanceOf(address(exchange));
        uint256 collateral = quote.balanceOf(address(ctf));
        feeVault.claimFees(secondBuyer, ids, amounts);
        assertEq(ctf.balanceOf(secondBuyer, ids[0]), amounts[0], "earned stock claimed");
        assertEq(ctf.balanceOf(secondBuyer, ids[1]), amounts[1], "earned cash claimed");
        assertEq(quote.balanceOf(address(exchange)), escrow, "live escrow untouched");
        assertEq(
            quote.balanceOf(address(ctf)), collateral, "claim withdrawal does not take backing"
        );
        vm.expectRevert();
        feeVault.claimFees(secondBuyer, ids, amounts);
        assertEq(ctf.balanceOf(secondBuyer, ids[0]), amounts[0], "no double withdrawal");
        assertTrue(
            !ctf.isApprovedForAll(address(exchange), address(feeVault)), "vault cannot pull escrow"
        );
        assertTrue(
            !ctf.isApprovedForAll(address(settlement), address(feeVault)),
            "vault cannot pull settlement"
        );
    }

    function testInvalidBatchRecipientAndOverWithdrawalRevertAtomically() public {
        _earn(buyer);
        (uint256[] memory ids, uint256[] memory amounts) = _ids();
        vm.expectRevert(ProtocolFeeVault.InvalidAddress.selector);
        feeVault.claimFees(address(0), ids, amounts);
        vm.expectRevert(ProtocolFeeVault.InvalidAddress.selector);
        feeVault.claimFees(address(feeVault), ids, amounts);
        vm.expectRevert(ProtocolFeeVault.InvalidBatch.selector);
        feeVault.claimFees(buyer, new uint256[](0), new uint256[](0));
        vm.expectRevert(ProtocolFeeVault.InvalidBatch.selector);
        feeVault.claimFees(buyer, ids, new uint256[](1));
        vm.expectRevert(ProtocolFeeVault.InvalidBatch.selector);
        feeVault.claimFees(buyer, new uint256[](65), new uint256[](65));
        amounts[1] += 1;
        vm.expectRevert();
        feeVault.claimFees(buyer, ids, amounts);
        assertEq(
            ctf.balanceOf(address(feeVault), ids[0]), 1e16, "first asset withdrawal rolled back"
        );
        ids[1] = ids[0];
        amounts[1] = amounts[0];
        vm.expectRevert();
        feeVault.claimFees(buyer, ids, amounts);
        assertEq(ctf.balanceOf(address(feeVault), ids[0]), 1e16, "duplicate ID cannot overdraft");
    }

    function testRejectingRecipientCannotLoseFeesAndReentrancyCannotDoubleClaim() public {
        _earn(buyer);
        FeeVaultReceiver receiver = new FeeVaultReceiver(feeVault);
        (uint256[] memory ids, uint256[] memory amounts) = _ids();
        receiver.configure(true, false);
        vm.expectRevert();
        feeVault.claimFees(address(receiver), ids, amounts);
        assertEq(ctf.balanceOf(address(feeVault), ids[0]), amounts[0], "reject rolls back");
        _transferAdmin(address(receiver));
        receiver.configure(false, true);
        vm.prank(address(receiver));
        feeVault.claimFees(address(receiver), ids, amounts);
        assertTrue(!receiver.reentered(), "even authorized admin callback cannot reenter");
        assertEq(ctf.balanceOf(address(receiver), ids[0]), amounts[0], "withdrawal only once");
        vm.expectRevert();
        feeVault.setFeeRates(0, 0);
        vm.prank(address(receiver));
        feeVault.setFeeRates(0, 0);
        assertEq(feeVault.makerFeeBps(), 0, "new admin inherits fee management");
    }

    function testCanonicalTokenOnlyAndNoArbitraryCallsOrApprovals() public {
        vm.expectRevert(ProtocolFeeVault.UnsupportedToken.selector);
        feeVault.onERC1155Received(address(this), buyer, 1, 1, "");
        vm.expectRevert(ProtocolFeeVault.UnsupportedToken.selector);
        feeVault.onERC1155BatchReceived(
            address(this), buyer, new uint256[](0), new uint256[](0), ""
        );
        assertTrue(
            feeVault.supportsInterface(type(IERC1155Receiver).interfaceId), "ERC1155 interface"
        );
        assertTrue(feeVault.supportsInterface(0x01ffc9a7), "ERC165 interface");
        assertTrue(!feeVault.supportsInterface(0xffffffff), "invalid interface rejected");
        (bool succeeded,) = address(feeVault)
            .call(abi.encodeWithSignature("execute(address,bytes)", address(ctf), hex"00"));
        assertTrue(!succeeded, "no arbitrary execution");
        assertTrue(!ctf.isApprovedForAll(address(feeVault), buyer), "no spending approval");
    }

    function testCanonicalBatchDonationsCanBeClaimedWithoutDuplicateAccounting() public {
        _splitFor(buyer, stock, 1e18);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = market.stockYesPositionId;
        ids[1] = market.stockNoPositionId;
        amounts[0] = 123;
        amounts[1] = 456;
        vm.prank(buyer);
        ctf.safeBatchTransferFrom(buyer, address(feeVault), ids, amounts, "");
        feeVault.claimFees(secondBuyer, ids, amounts);
        assertEq(ctf.balanceOf(secondBuyer, ids[0]), 123, "canonical donated YES claims");
        assertEq(ctf.balanceOf(secondBuyer, ids[1]), 456, "canonical donated NO claims");
    }

    function testConstructorRejectsZeroAndMismatchedVaultWiring() public {
        IProtocolAuthority auth = IProtocolAuthority(address(authority));
        vm.expectRevert(ProtocolFeeVault.InvalidAddress.selector);
        new ProtocolFeeVault(IConditionalTokens(address(0)), auth);
        vm.expectRevert(ProtocolFeeVault.InvalidAddress.selector);
        new ProtocolFeeVault(IConditionalTokens(buyer), auth);
        vm.expectRevert();
        new ProtocolFeeVault(ctf, IProtocolAuthority(address(0)));
        vm.expectRevert(ConditionalSettlement.InvalidAddress.selector);
        new ConditionalSettlement(ctf, registry, address(exchange), ProtocolFeeVault(address(0)));
        ProtocolAuthority other = new ProtocolAuthority(buyer, buyer, buyer, buyer);
        ProtocolFeeVault wrong = new ProtocolFeeVault(ctf, IProtocolAuthority(address(other)));
        vm.expectRevert(ConditionalSettlement.InvalidAddress.selector);
        new ConditionalSettlement(ctf, registry, address(exchange), wrong);
    }

    function _resolve(
        uint256 yes,
        uint256 no
    ) private {
        bytes32 evidence = keccak256("FEE_RESOLUTION");
        string memory uri = "ipfs://fee-resolution";
        registry.freezeMarket(marketId, evidence);
        registry.beginResolution(
            marketId,
            resolutionController.hashResolution(marketId, yes, no, yes + no, evidence, uri)
        );
        resolutionController.resolveMarket(marketId, yes, no, yes + no, evidence, uri);
    }

    function testFuzzVaultRedeemsWinningLosingOrInvalidClaimsWithoutRedemptionFee(
        uint8 seed
    ) public {
        _earn(buyer);
        uint256 outcome = seed % 3;
        _resolve(outcome == 1 ? 0 : 1, outcome == 0 ? 0 : 1);
        uint256[] memory sets = new uint256[](1);
        sets[0] = 1;
        uint256 expected = outcome == 0 ? 1e16 : outcome == 1 ? 0 : 5e15;
        uint256 beforeStock = stock.balanceOf(secondBuyer);
        assertEq(
            feeVault.redeemFees(stock, market.conditionId, sets, secondBuyer),
            expected,
            "vault payout equals canonical entitlement"
        );
        assertEq(stock.balanceOf(secondBuyer), beforeStock + expected, "all payout forwarded");
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId), 0, "fee claims burned"
        );
        assertEq(stock.balanceOf(address(feeVault)), 0, "no transient collateral residue");
        assertEq(
            feeVault.redeemFees(stock, market.conditionId, sets, secondBuyer),
            0,
            "no repeated payout"
        );
        // Users still redeem directly without paying any additional fee.
        beforeStock = stock.balanceOf(buyer);
        vm.prank(buyer);
        ctf.redeemPositions(stock, bytes32(0), market.conditionId, sets);
        uint256 userExpected = outcome == 0 ? 99e16 : outcome == 1 ? 0 : 495e15;
        assertEq(
            stock.balanceOf(buyer), beforeStock + userExpected, "user redemption remains fee-free"
        );
    }

    function testRedemptionRevertsUntilResolvedAndMalformedSetsAreRejected() public {
        _earn(buyer);
        uint256[] memory sets = new uint256[](1);
        sets[0] = 1;
        vm.expectRevert();
        feeVault.redeemFees(stock, market.conditionId, sets, secondBuyer);
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId),
            1e16,
            "unresolved redemption preserves fees"
        );
        vm.expectRevert(ProtocolFeeVault.InvalidAddress.selector);
        feeVault.redeemFees(stock, market.conditionId, sets, address(0));
        sets[0] = 3;
        vm.expectRevert(ProtocolFeeVault.InvalidBatch.selector);
        feeVault.redeemFees(stock, market.conditionId, sets, buyer);
        vm.expectRevert(ProtocolFeeVault.InvalidBatch.selector);
        feeVault.redeemFees(stock, market.conditionId, new uint256[](0), buyer);
        vm.expectRevert(ProtocolFeeVault.InvalidBatch.selector);
        feeVault.redeemFees(stock, market.conditionId, new uint256[](3), buyer);
        sets = new uint256[](2);
        sets[0] = 1;
        sets[1] = 1;
        vm.expectRevert(ProtocolFeeVault.InvalidBatch.selector);
        feeVault.redeemFees(stock, market.conditionId, sets, buyer);
    }

    function testPausedCollateralRedemptionRollsBackAndCanBeRetried() public {
        _earn(buyer);
        _resolve(1, 0);
        uint256[] memory sets = new uint256[](2);
        sets[0] = 1;
        sets[1] = 2;
        stock.setPaused(true);
        vm.expectRevert();
        feeVault.redeemFees(stock, market.conditionId, sets, secondBuyer);
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId),
            1e16,
            "failed collateral payout does not burn earned claims"
        );
        stock.setPaused(false);
        assertEq(
            feeVault.redeemFees(stock, market.conditionId, sets, secondBuyer),
            1e16,
            "retry pays exactly once"
        );
    }

    function testAdminReceiverCannotChangeTheOtherSidesRateMidFill() public {
        MutableReceiver receiver = new MutableReceiver(buyer);
        receiver.setCallback(address(feeVault), abi.encodeCall(feeVault.setFeeRates, (1000, 1000)));
        // Prepare the orders and initial rates while this test is still the administrator.
        feeVault.setFeeRates(100, 200);
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            0,
            keccak256("SNAP_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            0,
            keccak256("SNAP_ASK")
        );
        bid.recipient = address(receiver);
        bid.maxFeeBps = 100;
        ask.maxFeeBps = 200;
        _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _transferAdmin(address(receiver));
        _matchOrders(bid, ask, 1e18);
        assertTrue(receiver.callbackSucceeded(), "admin rate change actually happened");
        assertEq(feeVault.takerFeeBps(), 1000, "new rate applies after this snapshot");
        assertEq(
            ctf.balanceOf(address(feeVault), market.quoteYesPositionId),
            4e18,
            "seller charged snapshotted 200 bps not 1000"
        );
    }
}
