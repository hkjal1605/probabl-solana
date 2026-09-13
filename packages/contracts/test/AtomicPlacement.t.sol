// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AtomicOrderRouter } from "../src/AtomicOrderRouter.sol";
import { ConditionalExchange } from "../src/ConditionalExchange.sol";
import { PayoutVault } from "../src/PayoutVault.sol";
import { IAtomicExchange } from "../src/interfaces/IAtomicExchange.sol";
import { IProtocolAuthority } from "../src/interfaces/IProtocolAuthority.sol";
import {
    Branch,
    FundingKind,
    Order,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { MutableReceiver } from "./AdversarialReceivers.t.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { Mock1271Wallet, MockERC20, SixDecimalToken } from "./mocks/MockTokens.sol";

contract AtomicTestWallet is MutableReceiver {
    constructor(
        address owner
    ) MutableReceiver(owner) { }

    function execute(
        address target,
        bytes calldata data
    ) external returns (bytes memory result) {
        require(msg.sender == signer, "ONLY_OWNER");
        bool success;
        (success, result) = target.call(data);
        if (!success) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
}

contract AtomicPlacementTest is ProtocolFixture {
    uint128 internal constant UNIT = 1e18;

    function _quoteUnit() internal pure override returns (uint256) {
        return 1e6;
    }

    function _newQuoteToken() internal override returns (MockERC20) {
        return new SixDecimalToken();
    }

    function _make(
        bool buy,
        uint128 quantity,
        uint128 price,
        uint256 salt
    ) internal view returns (Order memory) {
        return _order(
            buy ? buyer : seller,
            Branch.YES,
            buy ? Side.BUY : Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            price,
            TimeInForce.GTC,
            0,
            bytes32(salt)
        );
    }

    function _rest(
        Order memory order
    ) internal returns (bytes32) {
        return _openOrder(order, _sign(order, order.maker == buyer ? BUYER_KEY : SELLER_KEY));
    }

    function _place(
        Order memory taker,
        Order[] memory makers,
        uint128[] memory quantities,
        uint128[] memory remaining
    ) internal returns (bytes32) {
        bytes memory signature = _sign(taker, taker.maker == buyer ? BUYER_KEY : SELLER_KEY);
        vm.prank(taker.maker);
        return atomicRouter.placeAndMatch(
            taker, signature, makers, quantities, remaining, uint64(block.timestamp + 60)
        );
    }

    function _single(
        Order memory maker,
        uint128 fill
    )
        internal
        pure
        returns (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining)
    {
        makers = new Order[](1);
        makers[0] = maker;
        amounts = new uint128[](1);
        amounts[0] = fill;
        remaining = new uint128[](1);
        remaining[0] = maker.quantity;
    }

    function testGtcSweepsPricesAndLeavesExactRemainderThenBecomesMaker() public {
        feeVault.setFeeRates(100, 200);
        Order memory ask1 = _make(false, 3 * UNIT, 100e6, 1);
        Order memory ask2 = _make(false, 2 * UNIT, 101e6, 2);
        ask1.maxFeeBps = 200;
        ask2.maxFeeBps = 200;
        _rest(ask1);
        _rest(ask2);
        Order memory taker = _make(true, 8 * UNIT, 101e6, 3);
        taker.maxFeeBps = 200;
        Order[] memory makers = new Order[](2);
        makers[0] = ask1;
        makers[1] = ask2;
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = 3 * UNIT;
        amounts[1] = 2 * UNIT;
        uint256 beforeBalance = quote.balanceOf(buyer);
        bytes32 hash = _place(taker, makers, amounts, amounts);
        assertEq(
            quote.balanceOf(buyer),
            beforeBalance - 502e6 - 303e6,
            "cost plus exact remaining escrow"
        );
        assertEq(exchange.getOrderState(hash).remaining, 3 * UNIT, "GTC remainder");
        assertEq(exchange.getOrderState(hash).reserved, 303e6, "GTC reservation");
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 4.9e18, "taker net active claims");
        assertEq(ctf.balanceOf(address(feeVault), market.stockYesPositionId), 0.1e18, "taker fee");
        Order memory later = _make(false, 3 * UNIT, 100e6, 4);
        later.maxFeeBps = 200;
        (makers, amounts,) = _single(taker, 3 * UNIT);
        uint128[] memory remaining = new uint128[](1);
        remaining[0] = 3 * UNIT;
        _place(later, makers, amounts, remaining);
        assertEq(
            uint256(exchange.getOrderState(hash).status),
            uint256(OrderStatus.FILLED),
            "resting remainder filled"
        );
        assertEq(
            ctf.balanceOf(buyer, market.stockYesPositionId), 7.87e18, "remainder charged maker rate"
        );
        assertEq(exchange.marketOpenNotional(marketId), 0, "all cap released");
        assertEq(quote.balanceOf(address(exchange)), 0, "no residual quote");
    }

    function testFuzzBothSidesBranchesFundingKindsAndRemainders(
        uint64 seed,
        bool buy,
        bool no,
        bool ioc,
        bool claimTaker,
        bool claimMaker
    ) public {
        uint128 fill = uint128((uint256(seed) % 1000 + 1) * 1e15);
        Order memory maker = _make(!buy, fill, 100e6, 11);
        Order memory taker = _make(buy, fill * 2, buy ? 101e6 : 99e6, 12);
        maker.branch = no ? Branch.NO : Branch.YES;
        taker.branch = maker.branch;
        taker.tif = ioc ? TimeInForce.IOC : TimeInForce.GTC;
        if (claimMaker) {
            maker.fundingKind = FundingKind.ACTIVE_CLAIM;
            _splitFor(maker.maker, buy ? stock : quote, buy ? fill : uint256(fill) * 100e6 / 1e18);
        }
        if (claimTaker) {
            taker.fundingKind = FundingKind.ACTIVE_CLAIM;
            _splitFor(
                taker.maker,
                buy ? quote : stock,
                buy ? uint256(taker.quantity) * 101e6 / 1e18 : taker.quantity
            );
        }
        bytes32 makerHash = _rest(maker);
        (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
            _single(maker, fill);
        bytes32 hash = _place(taker, makers, amounts, remaining);
        assertEq(
            uint256(exchange.getOrderState(makerHash).status),
            uint256(OrderStatus.FILLED),
            "maker consumed"
        );
        assertEq(
            uint256(exchange.getOrderState(hash).status),
            uint256(ioc ? OrderStatus.CANCELLED : OrderStatus.OPEN),
            "time in force"
        );
        assertEq(exchange.getOrderState(hash).remaining, ioc ? 0 : fill, "remaining quantity");
        uint256 stockId = no ? market.stockNoPositionId : market.stockYesPositionId;
        uint256 quoteId = no ? market.quoteNoPositionId : market.quoteYesPositionId;
        assertEq(ctf.balanceOf(buyer, stockId), fill, "buyer receives stock");
        assertEq(
            ctf.balanceOf(seller, quoteId),
            uint256(fill) * 100e6 / 1e18,
            "seller receives maker-price quote"
        );
        if (!ioc) {
            vm.prank(taker.maker);
            exchange.cancelOrder(hash);
        }
        assertEq(exchange.marketOpenNotional(marketId), 0, "recoverable exact caps");
        assertEq(quote.balanceOf(address(exchange)), 0, "no whole quote lost");
        assertEq(stock.balanceOf(address(exchange)), 0, "no whole stock lost");
    }

    function testNoMatchGtcRestsAndNoMatchIocRefunds() public {
        Order memory taker = _make(true, UNIT, 100e6, 21);
        uint256 beforeBalance = quote.balanceOf(buyer);
        bytes32 resting = _rest(taker);
        assertEq(exchange.getOrderState(resting).remaining, UNIT, "unmatched GTC rests");
        taker.salt = bytes32(uint256(22));
        taker.tif = TimeInForce.IOC;
        bytes32 cancelled = _place(taker, new Order[](0), new uint128[](0), new uint128[](0));
        assertEq(
            uint256(exchange.getOrderState(cancelled).status),
            uint256(OrderStatus.CANCELLED),
            "empty IOC terminal"
        );
        assertEq(quote.balanceOf(buyer), beforeBalance - 100e6, "only GTC holds funding");
    }

    function testOwnerTransactionRequiredEvenWithValidLeakedSignature() public {
        Order memory taker = _make(true, UNIT, 100e6, 31);
        bytes memory signature = _sign(taker, BUYER_KEY);
        vm.expectRevert(AtomicOrderRouter.NotOrderOwner.selector);
        atomicRouter.placeAndMatch(
            taker,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            uint64(block.timestamp + 60)
        );
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalExchange.UnauthorizedAtomicRouter.selector, buyer)
        );
        exchange.openOrder(taker, signature);
        assertEq(exchange.marketOpenNotional(marketId), 0, "no stripped-plan escrow");
    }

    function testDeadlineAndSignatureReplayAreEnforced() public {
        Order memory taker = _make(true, UNIT, 100e6, 41);
        bytes memory signature = _sign(taker, BUYER_KEY);
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.QuoteExpired.selector);
        atomicRouter.placeAndMatch(
            taker,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            uint64(block.timestamp)
        );
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.QuoteExpired.selector);
        atomicRouter.placeAndMatch(
            taker, signature, new Order[](0), new uint128[](0), new uint128[](0), taker.expiry + 1
        );
        bytes32 hash = _rest(taker);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ConditionalExchange.DuplicateOrder.selector, hash));
        atomicRouter.placeAndMatch(
            taker,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            uint64(block.timestamp + 60)
        );
    }

    function testStalePartialMakerFailsEvenWhenEnoughQuantityRemains() public {
        Order memory maker = _make(false, 2 * UNIT, 100e6, 51);
        bytes32 hash = _rest(maker);
        (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
            _single(maker, UNIT);
        _place(_make(true, UNIT, 100e6, 52), makers, amounts, remaining);
        Order memory stale = _make(true, UNIT, 100e6, 53);
        bytes memory signature = _sign(stale, BUYER_KEY);
        uint256 beforeBalance = quote.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AtomicOrderRouter.StaleMaker.selector, hash));
        atomicRouter.placeAndMatch(
            stale, signature, makers, amounts, remaining, uint64(block.timestamp + 60)
        );
        assertEq(quote.balanceOf(buyer), beforeBalance, "stale quote never funds");
        assertEq(exchange.getOrderState(hash).remaining, UNIT, "stale quote never fills");
    }

    function testLastLegPriceFailureRollsBackOpeningEarlierFillAndFees() public {
        feeVault.setFeeRates(100, 200);
        Order memory good = _make(false, UNIT, 100e6, 61);
        good.maxFeeBps = 200;
        Order memory bad = _make(false, UNIT, 102e6, 62);
        bad.maxFeeBps = 200;
        bytes32 goodHash = _rest(good);
        _rest(bad);
        Order memory taker = _make(true, 2 * UNIT, 101e6, 63);
        taker.maxFeeBps = 200;
        bytes memory signature = _sign(taker, BUYER_KEY);
        Order[] memory makers = new Order[](2);
        makers[0] = good;
        makers[1] = bad;
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = UNIT;
        amounts[1] = UNIT;
        uint256 balance = quote.balanceOf(buyer);
        bytes32 takerHash = exchange.hashOrder(taker);
        vm.prank(buyer);
        vm.expectRevert(ConditionalExchange.InvalidFill.selector);
        atomicRouter.placeAndMatch(
            taker, signature, makers, amounts, amounts, uint64(block.timestamp + 60)
        );
        assertEq(exchange.getOrderState(goodHash).remaining, UNIT, "first fill undone");
        assertEq(
            uint256(exchange.getOrderState(takerHash).status),
            uint256(OrderStatus.NONE),
            "opening undone"
        );
        assertEq(quote.balanceOf(buyer), balance, "funding undone");
        assertEq(ctf.balanceOf(address(feeVault), market.stockYesPositionId), 0, "fees undone");
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 0, "claims undone");
    }

    function testDuplicateMakerAndMalformedLengthsAreRejectedBeforeFunding() public {
        Order memory maker = _make(false, 2 * UNIT, 100e6, 71);
        _rest(maker);
        Order memory taker = _make(true, 2 * UNIT, 100e6, 72);
        bytes memory signature = _sign(taker, BUYER_KEY);
        Order[] memory makers = new Order[](2);
        makers[0] = maker;
        makers[1] = maker;
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = UNIT;
        amounts[1] = UNIT;
        uint128[] memory remaining = new uint128[](2);
        remaining[0] = 2 * UNIT;
        remaining[1] = 2 * UNIT;
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.InvalidPlan.selector);
        atomicRouter.placeAndMatch(
            taker, signature, makers, amounts, remaining, uint64(block.timestamp + 60)
        );
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.InvalidPlan.selector);
        atomicRouter.placeAndMatch(
            taker, signature, makers, amounts, new uint128[](0), uint64(block.timestamp + 60)
        );
    }

    function testMaximumThirtyTwoMakersFitAndSettleInOnePlacement() public {
        Order[] memory makers = new Order[](32);
        uint128[] memory amounts = new uint128[](32);
        for (uint256 i; i < 32; ++i) {
            makers[i] = _make(false, UNIT, 100e6, 100 + i);
            amounts[i] = UNIT;
            _rest(makers[i]);
        }
        bytes32 hash = _place(_make(true, 32 * UNIT, 100e6, 200), makers, amounts, amounts);
        assertEq(
            uint256(exchange.getOrderState(hash).status),
            uint256(OrderStatus.FILLED),
            "32 maker sweep"
        );
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 32 * UNIT, "all claims delivered");
        assertEq(exchange.marketOpenNotional(marketId), 0, "all reservations consumed");
    }

    function testInvalidPlanTermsNeverFundTheTaker() public {
        Order memory maker = _make(false, UNIT, 100e6, 301);
        _rest(maker);
        Order memory taker = _make(true, UNIT, 100e6, 302);
        bytes memory signature = _sign(taker, BUYER_KEY);
        uint256 balance = quote.balanceOf(buyer);
        for (uint256 variant; variant < 8; ++variant) {
            (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
                _single(maker, UNIT);
            if (variant == 0) makers[0].branch = Branch.NO;
            if (variant == 1) makers[0].side = Side.BUY;
            if (variant == 2) makers[0].tif = TimeInForce.IOC;
            if (variant == 3) makers[0].marketId = bytes32(uint256(1));
            if (variant == 4) amounts[0] = 0;
            if (variant == 5) amounts[0] = UNIT + 1;
            if (variant == 6) makers = new Order[](33);
            if (variant == 7) amounts = new uint128[](0);
            vm.prank(buyer);
            vm.expectRevert(AtomicOrderRouter.InvalidPlan.selector);
            atomicRouter.placeAndMatch(
                taker, signature, makers, amounts, remaining, uint64(block.timestamp + 60)
            );
            assertEq(quote.balanceOf(buyer), balance, "invalid plan has no funding effects");
        }
    }

    function testExcessTotalAcrossDistinctMakersRevertsBeforeOpening() public {
        Order[] memory makers = new Order[](2);
        uint128[] memory amounts = new uint128[](2);
        for (uint256 i; i < 2; ++i) {
            makers[i] = _make(false, UNIT, 100e6, 310 + i);
            amounts[i] = UNIT;
            _rest(makers[i]);
        }
        Order memory taker = _make(true, UNIT, 100e6, 312);
        bytes memory signature = _sign(taker, BUYER_KEY);
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.InvalidPlan.selector);
        atomicRouter.placeAndMatch(
            taker, signature, makers, amounts, amounts, uint64(block.timestamp + 60)
        );
        assertEq(
            uint256(exchange.getOrderState(exchange.hashOrder(taker)).status),
            uint256(OrderStatus.NONE),
            "no opening"
        );
    }

    function testMakerCancellationInvalidationAndExpiryFailAtomically() public {
        for (uint256 variant; variant < 3; ++variant) {
            Order memory maker = _make(false, UNIT, 100e6, 320 + variant);
            // variant is bounded by the three iterations above, so this cast is exact.
            // forge-lint: disable-next-line(unsafe-typecast)
            maker.nonce = uint64(variant);
            maker.expiry = uint64(block.timestamp + 20);
            bytes32 hash = _rest(maker);
            if (variant == 0) {
                vm.prank(seller);
                exchange.cancelOrder(hash);
            }
            if (variant == 1) {
                vm.prank(seller);
                exchange.cancelUpTo(2);
            }
            if (variant == 2) vm.warp(block.timestamp + 20);
            Order memory taker = _make(true, UNIT, 100e6, 330 + variant);
            bytes memory signature = _sign(taker, BUYER_KEY);
            (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
                _single(maker, UNIT);
            uint256 balance = quote.balanceOf(buyer);
            vm.prank(buyer);
            vm.expectRevert();
            atomicRouter.placeAndMatch(
                taker, signature, makers, amounts, remaining, uint64(block.timestamp + 60)
            );
            assertEq(quote.balanceOf(buyer), balance, "obsolete maker cannot consume funding");
        }
    }

    function testFeeChangeBeyondEitherSignedCapRollsBackTheWholePlacement() public {
        Order memory maker = _make(false, UNIT, 100e6, 341);
        maker.maxFeeBps = 100;
        _rest(maker);
        Order memory taker = _make(true, UNIT, 100e6, 342);
        taker.maxFeeBps = 100;
        (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
            _single(maker, UNIT);
        bytes memory signature = _sign(taker, BUYER_KEY);
        for (uint256 side; side < 2; ++side) {
            feeVault.setFeeRates(side == 0 ? 101 : 100, side == 0 ? 100 : 101);
            uint256 balance = quote.balanceOf(buyer);
            vm.prank(buyer);
            vm.expectRevert();
            atomicRouter.placeAndMatch(
                taker, signature, makers, amounts, remaining, uint64(block.timestamp + 60)
            );
            assertEq(quote.balanceOf(buyer), balance, "fee cap rollback");
            assertEq(
                ctf.balanceOf(address(feeVault), market.stockYesPositionId), 0, "no fee on failure"
            );
        }
        feeVault.setFeeRates(100, 100);
        _place(taker, makers, amounts, remaining);
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 0.99e18, "cap boundary succeeds");
    }

    function testSmartWalletExecutesOwnPlanAndCannotReenterRouter() public {
        AtomicTestWallet smart = new AtomicTestWallet(buyer);
        quote.mint(address(smart), 200e6);
        smart.approveToken(quote, address(exchange));
        Order memory maker = _make(false, UNIT, 100e6, 351);
        _rest(maker);
        Order memory taker = _make(true, UNIT, 100e6, 352);
        taker.maker = address(smart);
        taker.recipient = address(smart);
        (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
            _single(maker, UNIT);
        bytes memory callData = abi.encodeCall(
            AtomicOrderRouter.placeAndMatch,
            (
                taker,
                _sign(taker, BUYER_KEY),
                makers,
                amounts,
                remaining,
                uint64(block.timestamp + 60)
            )
        );
        smart.setCallback(address(atomicRouter), callData);
        vm.prank(buyer);
        smart.execute(address(atomicRouter), callData);
        assertTrue(!smart.callbackSucceeded(), "router reentry blocked");
        assertEq(
            ctf.balanceOf(address(smart), market.stockYesPositionId),
            UNIT,
            "ERC1271 owner received claims"
        );
        assertEq(exchange.marketOpenNotional(marketId), 0, "no reentry escrow");
    }

    function testRejectingRestingRecipientGetsCreditWithoutBlockingCounterparty() public {
        MutableReceiver recipient = new MutableReceiver(seller);
        Order memory maker = _make(false, UNIT, 100e6, 361);
        maker.recipient = address(recipient);
        bytes32 hash = _rest(maker);
        recipient.setBehavior(true, false);
        Order memory taker = _make(true, UNIT, 100e6, 362);
        (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
            _single(maker, UNIT);
        bytes memory signature = _sign(taker, BUYER_KEY);
        uint256 balance = quote.balanceOf(buyer);
        vm.prank(buyer);
        atomicRouter.placeAndMatch(
            taker, signature, makers, amounts, remaining, uint64(block.timestamp + 60)
        );
        assertEq(exchange.getOrderState(hash).remaining, 0, "maker filled");
        assertEq(quote.balanceOf(buyer), balance - 100e6, "taker pays exact quote");
        assertEq(
            ctf.balanceOf(buyer, market.stockYesPositionId), UNIT, "counterparty paid normally"
        );
        assertEq(ctf.balanceOf(seller, market.stockNoPositionId), UNIT, "complement paid normally");
        assertEq(
            exchange.payoutVault()
                .claimable(address(recipient), address(ctf), market.quoteYesPositionId),
            100e6,
            "only failed payout credited"
        );
        assertEq(exchange.marketOpenNotional(marketId), 0, "no stuck escrow or cap");
        PayoutVault payouts = exchange.payoutVault();
        vm.prank(address(recipient));
        payouts.withdraw(address(ctf), market.quoteYesPositionId, 100e6, seller);
        assertEq(
            ctf.balanceOf(seller, market.quoteYesPositionId),
            100e6,
            "recipient can recover elsewhere"
        );
    }

    function testCallbackCannotInvalidateALaterLegBecauseAllFillsPrecedeDelivery() public {
        feeVault.setFeeRates(100, 200);
        AtomicTestWallet smart = new AtomicTestWallet(seller);
        stock.mint(address(smart), 2 * UNIT);
        smart.approveToken(stock, address(exchange));
        Order[] memory makers = new Order[](2);
        uint128[] memory amounts = new uint128[](2);
        for (uint256 i; i < 2; ++i) {
            makers[i] = _make(false, UNIT, 100e6, 370 + i);
            makers[i].maker = address(smart);
            makers[i].recipient = address(smart);
            makers[i].maxFeeBps = 200;
            amounts[i] = UNIT;
            bytes memory opening = abi.encodeCall(
                AtomicOrderRouter.placeAndMatch,
                (
                    makers[i],
                    _sign(makers[i], SELLER_KEY),
                    new Order[](0),
                    new uint128[](0),
                    new uint128[](0),
                    uint64(block.timestamp + 60)
                )
            );
            vm.prank(seller);
            smart.execute(address(atomicRouter), opening);
        }
        // Nonce invalidation remains allowed, but cannot occur until every leg is accounted.
        smart.setCallback(address(exchange), abi.encodeCall(ConditionalExchange.cancelUpTo, (1)));
        Order memory taker = _make(true, 2 * UNIT, 100e6, 372);
        taker.maxFeeBps = 200;
        bytes memory signature = _sign(taker, BUYER_KEY);
        uint256 balance = quote.balanceOf(buyer);
        vm.prank(buyer);
        atomicRouter.placeAndMatch(
            taker, signature, makers, amounts, amounts, uint64(block.timestamp + 60)
        );
        for (uint256 i; i < 2; ++i) {
            assertEq(
                exchange.getOrderState(exchange.hashOrder(makers[i])).remaining,
                0,
                "every maker filled before callbacks"
            );
        }
        assertEq(
            uint256(exchange.getOrderState(exchange.hashOrder(taker)).status),
            uint256(OrderStatus.FILLED),
            "complete taker fill"
        );
        assertEq(exchange.minimumNonce(address(smart)), 1, "future orders invalidated only");
        assertEq(exchange.marketOpenNotional(marketId), 0, "caps released");
        assertEq(quote.balanceOf(buyer), balance - 200e6, "exact funding spent");
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId), 0.04e18, "fees retained"
        );
        assertEq(
            ctf.balanceOf(buyer, market.stockYesPositionId),
            1.96e18,
            "all deliveries completed despite callback"
        );
    }

    function testPauseAndTradingCutoffRejectAtomicOpeningWithoutTouchingRestingOrders() public {
        Order memory maker = _make(false, UNIT, 100e6, 380);
        bytes32 hash = _rest(maker);
        Order memory taker = _make(true, UNIT, 100e6, 381);
        (Order[] memory makers, uint128[] memory amounts, uint128[] memory remaining) =
            _single(maker, UNIT);
        bytes memory signature = _sign(taker, BUYER_KEY);
        exchange.setTradingPaused(true, keccak256("ATOMIC_PAUSE"));
        vm.prank(buyer);
        vm.expectRevert(ConditionalExchange.ContractPaused.selector);
        atomicRouter.placeAndMatch(
            taker, signature, makers, amounts, remaining, uint64(block.timestamp + 60)
        );
        exchange.setTradingPaused(false, keccak256("ATOMIC_RESUME"));
        vm.warp(market.tradingCutoff);
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.QuoteExpired.selector);
        atomicRouter.placeAndMatch(taker, signature, makers, amounts, remaining, taker.expiry);
        assertEq(exchange.getOrderState(hash).remaining, UNIT, "maker escrow remains recoverable");
        vm.prank(seller);
        exchange.cancelOrder(hash);
        assertEq(
            exchange.marketOpenNotional(marketId), 0, "cancellation remains available after cutoff"
        );
    }

    function testInvalidRouterConstructionRejected() public {
        vm.expectRevert(AtomicOrderRouter.InvalidAddress.selector);
        new AtomicOrderRouter(IAtomicExchange(address(0)), IProtocolAuthority(address(authority)));
        vm.expectRevert(AtomicOrderRouter.InvalidAddress.selector);
        new AtomicOrderRouter(IAtomicExchange(buyer), IProtocolAuthority(address(authority)));
        vm.expectRevert(AtomicOrderRouter.InvalidAddress.selector);
        new AtomicOrderRouter(IAtomicExchange(address(exchange)), IProtocolAuthority(address(0)));
        vm.expectRevert(AtomicOrderRouter.InvalidAddress.selector);
        new AtomicOrderRouter(IAtomicExchange(address(exchange)), IProtocolAuthority(buyer));
    }
}
