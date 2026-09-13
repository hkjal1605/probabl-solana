// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { OrderValidator } from "../src/OrderValidator.sol";
import { PayoutVault } from "../src/PayoutVault.sol";
import {
    Branch,
    FundingKind,
    Order,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { Mock1271Wallet } from "./mocks/MockTokens.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

contract MutableReceiver is Mock1271Wallet {
    bool public rejects;
    bool public burnsGas;
    bool public largeRevert;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    constructor(
        address signer
    ) Mock1271Wallet(signer) { }

    function setBehavior(
        bool reject_,
        bool gas_
    ) external {
        rejects = reject_;
        burnsGas = gas_;
    }

    function setLargeRevert(
        bool enabled
    ) external {
        largeRevert = enabled;
    }

    function setCallback(
        address target,
        bytes calldata data
    ) external {
        callbackTarget = target;
        callbackData = data;
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes memory
    ) public override returns (bytes4) {
        require(!rejects, "RECEIVER_REJECTED");
        if (largeRevert) assembly ("memory-safe") { revert(mload(0x40), 0x10000) }
        if (burnsGas) assembly ("memory-safe") { invalid() }
        if (callbackTarget != address(0)) (callbackSucceeded,) = callbackTarget.call(callbackData);
        return IERC1155Receiver.onERC1155Received.selector;
    }
}

contract GasGriefingInterface {
    function supportsInterface(
        bytes4
    ) external pure returns (bool) {
        assembly ("memory-safe") { invalid() }
    }
}

contract LyingInterface {
    function supportsInterface(
        bytes4
    ) external pure returns (bool) {
        return true;
    }
}

contract AdversarialReceiversTest is ProtocolFixture {
    function _pair(
        address recipient
    ) private returns (Order memory bid, Order memory ask, bytes32 bidHash, bytes32 askHash) {
        bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            210e18,
            TimeInForce.GTC,
            0,
            keccak256("CALLBACK_BID")
        );
        bid.recipient = recipient;
        ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            0,
            keccak256("CALLBACK_ASK")
        );
        bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        askHash = _openOrder(ask, _sign(ask, SELLER_KEY));
    }

    function testChangingReceiverBehaviorDefersOnlyItsPayout() public {
        _assertReceiverDeferral(0);
    }

    function testGasGriefingRecipientGetsBackedCredit() public {
        _assertReceiverDeferral(1);
    }

    function testLargeRevertRecipientGetsBackedCredit() public {
        _assertReceiverDeferral(2);
    }

    function _assertReceiverDeferral(
        uint256 behavior
    ) private {
        MutableReceiver receiver = new MutableReceiver(buyer);
        (Order memory bid, Order memory ask, bytes32 bidHash, bytes32 askHash) =
            _pair(address(receiver));
        receiver.setBehavior(behavior == 0, behavior == 1);
        receiver.setLargeRevert(behavior == 2);
        _matchOrders(bid, ask, 1e18);
        assertEq(
            uint256(exchange.getOrderState(bidHash).status),
            uint256(OrderStatus.FILLED),
            "bid filled"
        );
        assertEq(
            uint256(exchange.getOrderState(askHash).status),
            uint256(OrderStatus.FILLED),
            "ask filled"
        );
        assertEq(
            exchange.payoutVault()
                .claimable(address(receiver), address(ctf), market.stockYesPositionId),
            1e18,
            "failed payout credited"
        );
        assertEq(
            ctf.balanceOf(address(exchange.payoutVault()), market.stockYesPositionId),
            1e18,
            "exact backing"
        );
        assertEq(ctf.balanceOf(seller, market.quoteYesPositionId), 210e18, "other party unaffected");
        assertEq(
            ctf.balanceOf(seller, market.stockNoPositionId), 1e18, "seller complement delivered"
        );
        assertEq(
            ctf.balanceOf(buyer, market.quoteNoPositionId), 210e18, "buyer complement delivered"
        );
        assertEq(exchange.marketOpenNotional(marketId), 0, "no stranded risk cap");
        PayoutVault payouts = exchange.payoutVault();
        vm.prank(address(receiver));
        payouts.withdraw(address(ctf), market.stockYesPositionId, 1e18, buyer);
        assertEq(
            ctf.balanceOf(buyer, market.stockYesPositionId),
            1e18,
            "authorized alternate destination"
        );
    }

    function testReceiverCannotReenterCancellationDuringFill() public {
        MutableReceiver receiver = new MutableReceiver(buyer);
        quote.mint(address(receiver), 210e18);
        receiver.approveToken(quote, address(exchange));
        Order memory bid = _order(
            address(receiver),
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            210e18,
            TimeInForce.GTC,
            0,
            keccak256("REENTRANT_MAKER")
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
            keccak256("REENTRANT_ASK")
        );
        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        receiver.setCallback(
            address(exchange), abi.encodeWithSignature("cancelOrder(bytes32)", bidHash)
        );
        _matchOrders(bid, ask, 0.5e18);
        assertTrue(!receiver.callbackSucceeded(), "reentrant cancellation must fail");
        assertEq(
            ctf.balanceOf(address(receiver), market.stockYesPositionId), 0.5e18, "one delivery"
        );
        assertEq(
            exchange.getOrderState(bidHash).remaining,
            0.5e18,
            "callback could not cancel remaining escrow"
        );
    }

    function testBoundedInterfaceProbesRejectGasGriefAndFalseERC165() public {
        address[2] memory bad = [address(new GasGriefingInterface()), address(new LyingInterface())];
        for (uint256 i; i < bad.length; ++i) {
            Order memory bid = _order(
                buyer,
                Branch.YES,
                Side.BUY,
                FundingKind.WHOLE_COLLATERAL,
                1e18,
                210e18,
                TimeInForce.GTC,
                0,
                bytes32(i)
            );
            bid.recipient = bad[i];
            bytes memory signature = _sign(bid, BUYER_KEY);
            vm.expectRevert(
                abi.encodeWithSelector(OrderValidator.UnsupportedClaimDestination.selector, bad[i])
            );
            vm.prank(address(atomicRouter));
            exchange.openOrder{ gas: 500_000 }(bid, signature);
        }
    }

    function testSmartWalletCanRedirectRecoveryAfterItStartsRejectingClaims() public {
        MutableReceiver wallet = new MutableReceiver(buyer);
        _splitFor(buyer, quote, 210e18);
        vm.prank(buyer);
        ctf.safeTransferFrom(buyer, address(wallet), market.quoteYesPositionId, 210e18, "");
        wallet.approveClaims(ctf, address(exchange));
        Order memory bid = _order(
            address(wallet),
            Branch.YES,
            Side.BUY,
            FundingKind.ACTIVE_CLAIM,
            1e18,
            210e18,
            TimeInForce.GTC,
            0,
            keccak256("WALLET_RECOVERY")
        );
        bytes32 hash = _openOrder(bid, _sign(bid, BUYER_KEY));
        wallet.setBehavior(true, false);
        vm.prank(seller);
        vm.expectRevert();
        exchange.cancelOrderTo(hash, seller);
        assertEq(exchange.getOrderState(hash).reserved, 210e18, "reservation unchanged");
        vm.prank(address(wallet));
        exchange.cancelOrderTo(hash, buyer);
        assertEq(
            ctf.balanceOf(buyer, market.quoteYesPositionId),
            210e18,
            "maker authorized exact alternate recovery"
        );
        assertEq(exchange.marketOpenNotional(marketId), 0, "caps cleared");
    }

    function testGasGriefingMakerCannotStarveOtherRecoveryBatchEntries() public {
        _testRecoveryIsolation(false);
    }

    function testLargeReceiverRevertCannotStarveOtherRecoveryBatchEntries() public {
        _testRecoveryIsolation(true);
    }

    function _testRecoveryIsolation(
        bool largeRevert
    ) private {
        MutableReceiver wallet = new MutableReceiver(buyer);
        _splitFor(buyer, quote, 210e18);
        vm.prank(buyer);
        ctf.safeTransferFrom(buyer, address(wallet), market.quoteYesPositionId, 210e18, "");
        wallet.approveClaims(ctf, address(exchange));
        Order memory bad = _order(
            address(wallet),
            Branch.YES,
            Side.BUY,
            FundingKind.ACTIVE_CLAIM,
            1e18,
            210e18,
            TimeInForce.GTC,
            0,
            keccak256("GAS_GRIEF_RECOVERY")
        );
        bad.expiry = uint64(block.timestamp + 1);
        bytes32 badHash = _openOrder(bad, _sign(bad, BUYER_KEY));
        Order memory good = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            210e18,
            TimeInForce.GTC,
            0,
            keccak256("GOOD_RECOVERY")
        );
        good.expiry = bad.expiry;
        bytes32 goodHash = _openOrder(good, _sign(good, BUYER_KEY));
        wallet.setBehavior(false, !largeRevert);
        wallet.setLargeRevert(largeRevert);
        vm.warp(bad.expiry);
        bytes32[] memory batch = new bytes32[](3);
        batch[0] = badHash;
        batch[1] = badHash;
        batch[2] = goodHash;
        recoveryRouter.releaseExpired{ gas: 1_000_000 }(batch);
        assertEq(
            uint256(exchange.getOrderState(badHash).status),
            uint256(OrderStatus.CANCELLED),
            "bad receiver recovered into its credit"
        );
        assertEq(
            uint256(exchange.getOrderState(goodHash).status),
            uint256(OrderStatus.CANCELLED),
            "next maker recovered"
        );
    }
}
