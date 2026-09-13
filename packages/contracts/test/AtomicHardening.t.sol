// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AtomicOrderRouter } from "../src/AtomicOrderRouter.sol";
import { ConditionalExchange } from "../src/ConditionalExchange.sol";
import { PayoutVault } from "../src/PayoutVault.sol";
import {
    Branch,
    ExecutionGuard,
    FundingKind,
    MarketConfig,
    Order,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { MutableReceiver } from "./AdversarialReceivers.t.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";

contract AtomicHardeningTest is ProtocolFixture {
    function setUp() public override {
        super.setUp();
        string memory uri = "ipfs://atomic-final-caps";
        MarketConfig memory config = MarketConfig({
            baseToken: address(stock),
            quoteToken: address(quote),
            polymarketConditionId: keccak256(bytes(uri)),
            polymarketYesIndex: 1,
            polymarketNoIndex: 2,
            tradingOpen: uint64(block.timestamp),
            tradingCutoff: cutoff,
            rulesHash: keccak256(bytes(uri)),
            metadataHash: keccak256(bytes(uri)),
            priceTickRawX18: 1e18,
            baseStep: 1e18,
            minNotional: 1e18,
            maxOrderQuantity: 10e18,
            maxOrderNotional: 1000e18,
            maxWalletOpenNotional: 1000e18,
            maxMarketOpenNotional: 1000e18
        });
        marketId = registry.createMarket(config, uri);
        registry.openMarket(marketId);
        market = registry.getMarket(marketId);
        stock.mint(secondBuyer, 100e18);
    }

    function _make(
        address owner,
        Side side,
        uint128 quantity,
        uint256 salt
    ) private view returns (Order memory) {
        return _order(
            owner,
            Branch.YES,
            side,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            100e18,
            TimeInForce.GTC,
            0,
            bytes32(salt)
        );
    }

    function _key(
        address owner
    ) private view returns (uint256) {
        return owner == buyer ? BUYER_KEY : owner == seller ? SELLER_KEY : SECOND_BUYER_KEY;
    }

    function _rest(
        Order memory order
    ) private returns (bytes32) {
        return _openOrder(order, _sign(order, _key(order.maker)));
    }

    function _guard() private view returns (ExecutionGuard memory guard) {
        (uint16 makerFee, uint16 takerFee) = feeVault.feeRates();
        return ExecutionGuard(exchange.nextSequence(marketId, Branch.YES), makerFee, takerFee);
    }

    function _checked(
        Order memory taker,
        Order[] memory makers,
        uint128[] memory amounts,
        ExecutionGuard memory guard,
        bytes32[] memory releases
    ) private returns (bytes32) {
        uint128[] memory remaining = new uint128[](makers.length);
        for (uint256 i; i < makers.length; ++i) {
            remaining[i] = makers[i].quantity;
        }
        bytes memory signature = _sign(taker, _key(taker.maker));
        vm.prank(taker.maker);
        return atomicRouter.placeAndMatchChecked(
            taker,
            signature,
            makers,
            amounts,
            remaining,
            uint64(block.timestamp + 60),
            guard,
            releases
        );
    }

    function _fullBook() private returns (Order[] memory makers, uint128[] memory amounts) {
        makers = new Order[](2);
        amounts = new uint128[](2);
        makers[0] = _make(seller, Side.SELL, 5e18, 1);
        makers[1] = _make(secondBuyer, Side.SELL, 5e18, 2);
        amounts[0] = 5e18;
        amounts[1] = 5e18;
        _rest(makers[0]);
        _rest(makers[1]);
        assertEq(exchange.marketOpenNotional(marketId), 1000e18, "market saturated");
    }

    function testSaturatedMarketAcceptsFullyReducingTrade() public {
        (Order[] memory makers, uint128[] memory amounts) = _fullBook();
        Order memory taker = _make(buyer, Side.BUY, 10e18, 3);
        bytes32 hash = _checked(taker, makers, amounts, _guard(), new bytes32[](0));
        assertEq(
            uint256(exchange.getOrderState(hash).status), uint256(OrderStatus.FILLED), "full fill"
        );
        assertEq(exchange.marketOpenNotional(marketId), 0, "no resting risk");
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 10e18, "paid full fill");
    }

    function testPayoutVaultAndSettlementCannotBeSelectedAsUnclaimableRecipients() public {
        Order memory order = _make(buyer, Side.BUY, 1e18, 1);
        address[2] memory destinations = [address(exchange.payoutVault()), address(settlement)];
        for (uint256 i; i < destinations.length; ++i) {
            order.recipient = destinations[i];
            bytes memory signature = _sign(order, BUYER_KEY);
            vm.expectRevert(ConditionalExchange.InvalidOrder.selector);
            _openOrder(order, signature);
        }
    }

    function testSelfMakerReductionAlsoCountsTowardFinalWalletCap() public {
        Order[] memory makers = new Order[](2);
        uint128[] memory amounts = new uint128[](2);
        makers[0] = _make(buyer, Side.SELL, 6e18, 1);
        makers[1] = _make(secondBuyer, Side.SELL, 4e18, 2);
        amounts[0] = 6e18;
        amounts[1] = 4e18;
        _rest(makers[0]);
        _rest(makers[1]);
        _checked(_make(buyer, Side.BUY, 10e18, 3), makers, amounts, _guard(), new bytes32[](0));
        assertEq(exchange.walletOpenNotional(marketId, buyer), 0, "self-maker reduction credited");
        assertEq(exchange.marketOpenNotional(marketId), 0, "net market reduction");
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 10e18, "received every claim");
    }

    function testFinalGtcRemainderFitsEvenThoughGrossAdmissionWouldExceedCaps() public {
        (Order[] memory all,) = _fullBook();
        Order[] memory makers = new Order[](1);
        makers[0] = all[0];
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 5e18;
        Order memory taker = _make(buyer, Side.BUY, 10e18, 3);
        bytes32 hash = _checked(taker, makers, amounts, _guard(), new bytes32[](0));
        assertEq(exchange.getOrderState(hash).remaining, 5e18, "exact resting remainder");
        assertEq(exchange.walletOpenNotional(marketId, buyer), 500e18, "final wallet cap");
        assertEq(exchange.marketOpenNotional(marketId), 1000e18, "final market at cap");
    }

    function testIocRemainderDoesNotConsumeRestingCap() public {
        (Order[] memory all,) = _fullBook();
        Order[] memory makers = new Order[](1);
        makers[0] = all[0];
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 1e18;
        Order memory taker = _make(buyer, Side.BUY, 10e18, 3);
        taker.tif = TimeInForce.IOC;
        uint256 beforeQuote = quote.balanceOf(buyer);
        bytes32 hash = _checked(taker, makers, amounts, _guard(), new bytes32[](0));
        assertEq(exchange.getOrderState(hash).reserved, 0, "no IOC reservation");
        assertEq(exchange.walletOpenNotional(marketId, buyer), 0, "no IOC open risk");
        assertEq(exchange.marketOpenNotional(marketId), 900e18, "other makers retained");
        assertEq(quote.balanceOf(buyer), beforeQuote - 100e18, "remainder refunded");
    }

    function testFinalCapViolationRollsBackAllFillsStagingAndOpening() public {
        (Order[] memory all,) = _fullBook();
        Order[] memory makers = new Order[](1);
        makers[0] = all[0];
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 1e18;
        Order memory taker = _make(buyer, Side.BUY, 10e18, 3);
        bytes memory signature = _sign(taker, BUYER_KEY);
        ExecutionGuard memory guard = _guard();
        uint128[] memory remaining = new uint128[](1);
        remaining[0] = 5e18;
        uint256 beforeQuote = quote.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(ConditionalExchange.RiskCapExceeded.selector);
        atomicRouter.placeAndMatchChecked(
            taker,
            signature,
            makers,
            amounts,
            remaining,
            uint64(block.timestamp + 60),
            guard,
            new bytes32[](0)
        );
        assertEq(exchange.marketOpenNotional(marketId), 1000e18, "cap unchanged");
        assertEq(
            exchange.getOrderState(exchange.hashOrder(all[0])).remaining, 5e18, "maker unchanged"
        );
        assertEq(quote.balanceOf(buyer), beforeQuote, "funding rolled back");
        assertEq(
            ctf.balanceOf(address(exchange.payoutVault()), market.stockYesPositionId),
            0,
            "staging rolled back"
        );
        assertEq(
            exchange.nextSequence(marketId, Branch.YES), guard.nextSequence, "sequence rolled back"
        );
    }

    function testExpiredReservationsCanBeRecoveredInsidePlacementAtSaturation() public {
        Order memory stale = _make(buyer, Side.BUY, 6e18, 1);
        stale.expiry = uint64(block.timestamp + 1);
        bytes32 staleHash = _rest(stale);
        Order memory unrelated = _make(seller, Side.SELL, 4e18, 2);
        _rest(unrelated);
        vm.warp(block.timestamp + 1);
        bytes32[] memory releases = new bytes32[](1);
        releases[0] = staleHash;
        Order memory taker = _make(buyer, Side.BUY, 6e18, 3);
        _checked(taker, new Order[](0), new uint128[](0), _guard(), releases);
        assertEq(
            uint256(exchange.getOrderState(staleHash).status),
            uint256(OrderStatus.CANCELLED),
            "expired released"
        );
        assertEq(exchange.marketOpenNotional(marketId), 1000e18, "old reservation replaced");
        assertEq(
            exchange.walletOpenNotional(marketId, buyer), 600e18, "wallet released then reused"
        );
        assertEq(
            exchange.getOrderState(exchange.hashOrder(unrelated)).remaining,
            4e18,
            "unrelated unchanged"
        );
    }

    function testStaleReleaseIsIdempotentButCannotCancelValidOrCrossMarketOrders() public {
        Order memory stale = _make(seller, Side.SELL, 1e18, 1);
        bytes32 hash = _rest(stale);
        vm.prank(address(atomicRouter));
        vm.expectRevert(ConditionalExchange.OrderNotReleasable.selector);
        exchange.releaseStaleOrder(hash, marketId);
        vm.prank(address(atomicRouter));
        vm.expectRevert(ConditionalExchange.InvalidOrder.selector);
        exchange.releaseStaleOrder(hash, keccak256("WRONG_MARKET"));
        vm.prank(seller);
        exchange.cancelUpTo(1);
        exchange.releaseInvalidatedOrder(hash);
        bytes32[] memory releases = new bytes32[](1);
        releases[0] = hash;
        _checked(
            _make(buyer, Side.BUY, 1e18, 2), new Order[](0), new uint128[](0), _guard(), releases
        );
        assertEq(exchange.marketOpenNotional(marketId), 100e18, "concurrent release harmless");
    }

    function testNewLiquidityInvalidatesReviewedBookButOtherBranchDoesNot() public {
        ExecutionGuard memory guard = _guard();
        Order memory unrelated = _make(seller, Side.SELL, 1e18, 1);
        unrelated.branch = Branch.NO;
        _rest(unrelated);
        Order memory taker = _make(buyer, Side.BUY, 1e18, 2);
        _checked(taker, new Order[](0), new uint128[](0), guard, new bytes32[](0));
        Order memory later = _make(seller, Side.SELL, 1e18, 3);
        bytes memory signature = _sign(later, SELLER_KEY);
        vm.prank(seller);
        vm.expectRevert(AtomicOrderRouter.StaleBook.selector);
        atomicRouter.placeAndMatchChecked(
            later,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            uint64(block.timestamp + 60),
            guard,
            new bytes32[](0)
        );
        assertEq(
            exchange.getOrderState(exchange.hashOrder(taker)).remaining,
            1e18,
            "first quote remains resting"
        );
    }

    function testBoundedRecoveryRejectsDuplicatesAndOversizedInputBeforeFunding() public {
        Order memory taker = _make(buyer, Side.BUY, 1e18, 1);
        bytes memory signature = _sign(taker, BUYER_KEY);
        ExecutionGuard memory guard = _guard();
        uint256 before = quote.balanceOf(buyer);
        bytes32[] memory tooMany = new bytes32[](33);
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.InvalidPlan.selector);
        atomicRouter.placeAndMatchChecked(
            taker,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            uint64(block.timestamp + 60),
            guard,
            tooMany
        );
        bytes32[] memory repeated = new bytes32[](2);
        repeated[0] = keccak256("same");
        repeated[1] = repeated[0];
        vm.prank(buyer);
        vm.expectRevert(AtomicOrderRouter.InvalidPlan.selector);
        atomicRouter.placeAndMatchChecked(
            taker,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            uint64(block.timestamp + 60),
            guard,
            repeated
        );
        assertEq(quote.balanceOf(buyer), before, "funding untouched");
        assertEq(exchange.nextSequence(marketId, Branch.YES), guard.nextSequence, "book unchanged");
    }

    function testFeeDecreaseAsWellAsIncreaseInvalidatesEligibilitySnapshot() public {
        for (uint256 i; i < 2; ++i) {
            feeVault.setFeeRates(i == 0 ? 100 : 0, 0);
            ExecutionGuard memory guard = _guard();
            feeVault.setFeeRates(i == 0 ? 0 : 100, 0);
            Order memory taker = _make(buyer, Side.BUY, 1e18, i + 1);
            taker.maxFeeBps = 100;
            bytes memory signature = _sign(taker, BUYER_KEY);
            vm.prank(buyer);
            vm.expectRevert(AtomicOrderRouter.StaleFees.selector);
            atomicRouter.placeAndMatchChecked(
                taker,
                signature,
                new Order[](0),
                new uint128[](0),
                new uint128[](0),
                uint64(block.timestamp + 60),
                guard,
                new bytes32[](0)
            );
        }
        assertEq(exchange.nextSequence(marketId, Branch.YES), 0, "no unintended admissions");
    }

    function testBothRejectingPartiesKeepSeparateCreditsAndComplements() public {
        MutableReceiver buyRecipient = new MutableReceiver(buyer);
        MutableReceiver sellRecipient = new MutableReceiver(seller);
        Order memory maker = _make(seller, Side.SELL, 1e18, 1);
        maker.recipient = address(sellRecipient);
        _rest(maker);
        Order memory taker = _make(buyer, Side.BUY, 1e18, 2);
        taker.recipient = address(buyRecipient);
        buyRecipient.setBehavior(true, false);
        sellRecipient.setBehavior(true, false);
        Order[] memory makers = new Order[](1);
        makers[0] = maker;
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 1e18;
        _checked(taker, makers, amounts, _guard(), new bytes32[](0));
        PayoutVault vault = exchange.payoutVault();
        assertEq(
            vault.claimable(address(buyRecipient), address(ctf), market.stockYesPositionId),
            1e18,
            "buyer credit"
        );
        assertEq(
            vault.claimable(address(sellRecipient), address(ctf), market.quoteYesPositionId),
            100e18,
            "seller credit"
        );
        assertEq(
            ctf.balanceOf(seller, market.stockNoPositionId), 1e18, "seller complement delivered"
        );
        assertEq(
            ctf.balanceOf(buyer, market.quoteNoPositionId), 100e18, "buyer complement delivered"
        );
        assertEq(
            vault.claimable(buyer, address(ctf), market.quoteNoPositionId), 0, "no unrelated credit"
        );
    }
}
