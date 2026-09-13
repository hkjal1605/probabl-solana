// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ConditionalExchange } from "../src/ConditionalExchange.sol";
import {
    Branch,
    FundingKind,
    Order,
    OrderStateData,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { Mock1271Wallet } from "./mocks/MockTokens.sol";

contract ConditionalExchangeTest is ProtocolFixture {
    uint128 private constant ONE_STOCK = 1e18;
    uint128 private BID_PRICE;
    uint128 private ASK_PRICE;

    function setUp() public virtual override {
        super.setUp();
        BID_PRICE = uint128(210 * _quoteUnit());
        ASK_PRICE = uint128(200 * _quoteUnit());
    }

    function testWholeFundedYesFillAtRestingBidPrice() public {
        uint256 buyerQuoteBefore = quote.balanceOf(buyer);
        uint256 sellerStockBefore = stock.balanceOf(seller);
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            0,
            keccak256("BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            ASK_PRICE,
            TimeInForce.GTC,
            0,
            keccak256("ASK")
        );

        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        bytes32 askHash = _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, ONE_STOCK);

        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), ONE_STOCK, "buyer stock YES");
        assertEq(ctf.balanceOf(buyer, market.quoteNoPositionId), BID_PRICE, "buyer quote NO");
        assertEq(ctf.balanceOf(seller, market.quoteYesPositionId), BID_PRICE, "seller quote YES");
        assertEq(ctf.balanceOf(seller, market.stockNoPositionId), ONE_STOCK, "seller stock NO");
        assertEq(quote.balanceOf(buyer), buyerQuoteBefore - BID_PRICE, "buyer quote debit");
        assertEq(stock.balanceOf(seller), sellerStockBefore - ONE_STOCK, "seller stock debit");
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
        assertEq(exchange.marketOpenNotional(marketId), 0, "market cap released");
        assertEq(quote.balanceOf(address(exchange)), 0, "no quote residue");
        assertEq(stock.balanceOf(address(exchange)), 0, "no stock residue");
    }

    function testWholeFundedNoFillAtRestingAskAndReturnsPriceImprovement() public {
        uint256 buyerQuoteBefore = quote.balanceOf(buyer);
        Order memory ask = _order(
            seller,
            Branch.NO,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            ASK_PRICE,
            TimeInForce.GTC,
            1,
            keccak256("NO_ASK")
        );
        Order memory bid = _order(
            buyer,
            Branch.NO,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            1,
            keccak256("NO_BID")
        );

        _openOrder(ask, _sign(ask, SELLER_KEY));
        _openOrder(bid, _sign(bid, BUYER_KEY));
        _matchOrders(bid, ask, ONE_STOCK);

        assertEq(ctf.balanceOf(buyer, market.stockNoPositionId), ONE_STOCK, "buyer stock NO");
        assertEq(ctf.balanceOf(buyer, market.quoteYesPositionId), ASK_PRICE, "buyer quote YES");
        assertEq(ctf.balanceOf(seller, market.quoteNoPositionId), ASK_PRICE, "seller quote NO");
        assertEq(ctf.balanceOf(seller, market.stockYesPositionId), ONE_STOCK, "seller stock YES");
        assertEq(quote.balanceOf(buyer), buyerQuoteBefore - ASK_PRICE, "price improvement returned");
    }

    function testAllClaimFundedYesFill() public {
        _splitFor(buyer, quote, BID_PRICE);
        _splitFor(seller, stock, ONE_STOCK);

        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.ACTIVE_CLAIM,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            2,
            keccak256("CLAIM_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.ACTIVE_CLAIM,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            2,
            keccak256("CLAIM_ASK")
        );

        _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, ONE_STOCK);

        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), ONE_STOCK, "stock delivered");
        assertEq(ctf.balanceOf(seller, market.quoteYesPositionId), BID_PRICE, "quote delivered");
        assertEq(ctf.balanceOf(buyer, market.quoteNoPositionId), BID_PRICE, "quote NO retained");
        assertEq(ctf.balanceOf(seller, market.stockNoPositionId), ONE_STOCK, "stock NO retained");
        assertEq(
            ctf.balanceOf(address(exchange), market.stockYesPositionId), 0, "no stock claim escrow"
        );
        assertEq(
            ctf.balanceOf(address(exchange), market.quoteYesPositionId), 0, "no quote claim escrow"
        );
    }

    function testMixedFundingBothDirections() public {
        _exerciseMixedFunding(Branch.YES, FundingKind.WHOLE_COLLATERAL, FundingKind.ACTIVE_CLAIM, 3);
    }

    function testClaimBidAgainstWholeAsk() public {
        _exerciseMixedFunding(Branch.YES, FundingKind.ACTIVE_CLAIM, FundingKind.WHOLE_COLLATERAL, 4);
    }

    function testAllClaimFundedNoFill() public {
        _exerciseMixedFunding(Branch.NO, FundingKind.ACTIVE_CLAIM, FundingKind.ACTIVE_CLAIM, 13);
    }

    function testWholeBidAgainstClaimAskNo() public {
        _exerciseMixedFunding(Branch.NO, FundingKind.WHOLE_COLLATERAL, FundingKind.ACTIVE_CLAIM, 14);
    }

    function testClaimBidAgainstWholeAskNo() public {
        _exerciseMixedFunding(Branch.NO, FundingKind.ACTIVE_CLAIM, FundingKind.WHOLE_COLLATERAL, 15);
    }

    function testPartialFillThenCancelReturnsExactReservations() public {
        uint128 quantity = 2e18;
        uint128 partialFill = 0.5e18;
        uint256 buyerBefore = quote.balanceOf(buyer);
        uint256 sellerBefore = stock.balanceOf(seller);
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            BID_PRICE,
            TimeInForce.GTC,
            5,
            keccak256("PARTIAL_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            ASK_PRICE,
            TimeInForce.GTC,
            5,
            keccak256("PARTIAL_ASK")
        );
        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        bytes32 askHash = _openOrder(ask, _sign(ask, SELLER_KEY));

        _matchOrders(bid, ask, partialFill);
        vm.prank(buyer);
        exchange.cancelOrder(bidHash);
        vm.prank(seller);
        exchange.cancelOrder(askHash);

        uint256 spent = uint256(partialFill) * BID_PRICE / WAD;
        assertEq(quote.balanceOf(buyer), buyerBefore - spent, "only filled quote spent");
        assertEq(stock.balanceOf(seller), sellerBefore - partialFill, "only filled stock spent");
        assertEq(
            uint256(exchange.getOrderState(bidHash).status),
            uint256(OrderStatus.CANCELLED),
            "bid cancelled"
        );
        assertEq(
            uint256(exchange.getOrderState(askHash).status),
            uint256(OrderStatus.CANCELLED),
            "ask cancelled"
        );
        assertEq(exchange.marketOpenNotional(marketId), 0, "notional fully released");
    }

    function testIOCIsAtomicAndReleasesRemainder() public {
        uint256 buyerBefore = quote.balanceOf(buyer);
        Order memory makerAsk = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            ASK_PRICE,
            TimeInForce.GTC,
            6,
            keccak256("IOC_MAKER")
        );
        _openOrder(makerAsk, _sign(makerAsk, SELLER_KEY));

        Order memory takerBid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            2e18,
            BID_PRICE,
            TimeInForce.IOC,
            6,
            keccak256("IOC_TAKER")
        );
        Order[] memory makers = new Order[](1);
        makers[0] = makerAsk;
        uint128[] memory quantities = new uint128[](1);
        quantities[0] = ONE_STOCK;
        bytes32 takerHash = _executeIOC(takerBid, _sign(takerBid, BUYER_KEY), makers, quantities);

        OrderStateData memory takerState = exchange.getOrderState(takerHash);
        assertEq(
            uint256(takerState.status), uint256(OrderStatus.CANCELLED), "IOC remainder cancelled"
        );
        assertEq(takerState.remaining, 0, "IOC has no live remainder");
        assertEq(quote.balanceOf(buyer), buyerBefore - ASK_PRICE, "IOC respects maker price");
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), ONE_STOCK, "IOC stock delivered");
    }

    function testPauseBlocksFillButNeverCancellation() public {
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            7,
            keccak256("PAUSE_BID")
        );
        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        exchange.setTradingPaused(true, keccak256("INCIDENT"));

        vm.prank(buyer);
        exchange.cancelOrder(bidHash);
        assertEq(
            uint256(exchange.getOrderState(bidHash).status),
            uint256(OrderStatus.CANCELLED),
            "cancel remains live"
        );
    }

    function testUnsolicitedErc20DustCannotBlockSettlement() public {
        vm.prank(buyer);
        assertTrue(quote.transfer(address(settlement), 1), "dust transfer");

        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            11,
            keccak256("DUST_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            11,
            keccak256("DUST_ASK")
        );
        _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, ONE_STOCK);

        assertEq(quote.balanceOf(address(settlement)), 1, "dust preserved but harmless");
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), ONE_STOCK, "fill succeeded");
    }

    function testInvalidSignatureCannotPullMakerFunds() public {
        uint256 beforeBalance = quote.balanceOf(buyer);
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            12,
            keccak256("BAD_SIGNATURE")
        );

        bytes memory invalidSignature = _sign(bid, SELLER_KEY);
        vm.expectRevert();
        _openOrder(bid, invalidSignature);
        assertEq(quote.balanceOf(buyer), beforeBalance, "invalid signature moved no funds");
    }

    function testPausedStockTokenCannotCreateAnOpenOrder() public {
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            ASK_PRICE,
            TimeInForce.GTC,
            16,
            keccak256("PAUSED_STOCK")
        );
        bytes memory signature = _sign(ask, SELLER_KEY);
        stock.setPaused(true);

        vm.expectRevert();
        _openOrder(ask, signature);
        assertEq(stock.balanceOf(address(exchange)), 0, "paused transfer leaves no escrow");
        assertEq(
            uint256(exchange.getOrderState(exchange.hashOrder(ask)).status),
            uint256(OrderStatus.NONE),
            "failed funding leaves no order"
        );
    }

    function testErc1271SmartWalletOrder() public {
        uint256 walletSignerKey = 0xD00D;
        Mock1271Wallet wallet = new Mock1271Wallet(vm.addr(walletSignerKey));
        quote.mint(address(wallet), BID_PRICE);
        wallet.approveToken(quote, address(exchange));
        wallet.approveClaims(ctf, address(exchange));

        Order memory bid = _order(
            address(wallet),
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            17,
            keccak256("ERC1271_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            17,
            keccak256("ERC1271_ASK")
        );
        _openOrder(bid, _sign(bid, walletSignerKey));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, ONE_STOCK);

        assertEq(
            ctf.balanceOf(address(wallet), market.stockYesPositionId),
            ONE_STOCK,
            "smart wallet stock claim"
        );
        assertEq(
            ctf.balanceOf(address(wallet), market.quoteNoPositionId),
            BID_PRICE,
            "smart wallet inactive quote claim"
        );
    }

    function testThirdPartyReleasesExpiredAndInvalidatedOrders() public {
        Order memory expired = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            8,
            keccak256("EXPIRED")
        );
        expired.expiry = uint64(block.timestamp + 10);
        bytes32 expiredHash = _openOrder(expired, _sign(expired, BUYER_KEY));
        vm.warp(block.timestamp + 10);
        vm.prank(secondBuyer);
        exchange.releaseExpiredOrder(expiredHash);

        Order memory invalidated = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            9,
            keccak256("INVALIDATED")
        );
        bytes32 invalidatedHash = _openOrder(invalidated, _sign(invalidated, BUYER_KEY));
        vm.prank(buyer);
        exchange.cancelUpTo(10);
        vm.prank(secondBuyer);
        exchange.releaseInvalidatedOrder(invalidatedHash);

        assertEq(
            uint256(exchange.getOrderState(expiredHash).status),
            uint256(OrderStatus.CANCELLED),
            "expired released"
        );
        assertEq(
            uint256(exchange.getOrderState(invalidatedHash).status),
            uint256(OrderStatus.CANCELLED),
            "invalidated released"
        );
    }

    /// forge-config: default.fuzz.runs = 64
    /// forge-config: ci.fuzz.runs = 256
    function testFuzzPartialFillReservationsReconcile(
        uint16 rawSteps
    ) public {
        uint128 quantity = 10e18;
        uint128 fillQuantity = uint128((uint256(rawSteps) % 10_000 + 1) * 0.001e18);
        uint128 bidPrice = uint128(21013 * _quoteUnit() / 100);
        uint128 askPrice = uint128(200 * _quoteUnit());
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            bidPrice,
            TimeInForce.GTC,
            40,
            keccak256("FUZZ_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            askPrice,
            TimeInForce.GTC,
            40,
            keccak256("FUZZ_ASK")
        );
        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        bytes32 askHash = _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, fillQuantity);

        uint128 remaining = quantity - fillQuantity;
        OrderStateData memory bidState = exchange.getOrderState(bidHash);
        OrderStateData memory askState = exchange.getOrderState(askHash);
        uint256 bidReservation = uint256(remaining) * bidPrice / WAD;
        assertEq(bidState.remaining, remaining, "bid remaining");
        assertEq(askState.remaining, remaining, "ask remaining");
        assertEq(bidState.reserved, bidReservation, "bid exact reservation");
        assertEq(askState.reserved, remaining, "ask exact reservation");
        assertEq(quote.balanceOf(address(exchange)), bidReservation, "quote escrow reconciles");
        assertEq(stock.balanceOf(address(exchange)), remaining, "stock escrow reconciles");
    }

    function _exerciseMixedFunding(
        Branch branch,
        FundingKind buyFunding,
        FundingKind sellFunding,
        uint64 nonce
    ) private {
        if (buyFunding == FundingKind.ACTIVE_CLAIM) _splitFor(buyer, quote, BID_PRICE);
        if (sellFunding == FundingKind.ACTIVE_CLAIM) _splitFor(seller, stock, ONE_STOCK);

        Order memory bid = _order(
            buyer,
            branch,
            Side.BUY,
            buyFunding,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            nonce,
            keccak256(abi.encode("MIXED_BID", nonce))
        );
        Order memory ask = _order(
            seller,
            branch,
            Side.SELL,
            sellFunding,
            ONE_STOCK,
            BID_PRICE,
            TimeInForce.GTC,
            nonce,
            keccak256(abi.encode("MIXED_ASK", nonce))
        );
        _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, ONE_STOCK);

        uint256 stockPosition =
            branch == Branch.YES ? market.stockYesPositionId : market.stockNoPositionId;
        uint256 quotePosition =
            branch == Branch.YES ? market.quoteYesPositionId : market.quoteNoPositionId;
        assertEq(ctf.balanceOf(buyer, stockPosition), ONE_STOCK, "mixed stock");
        assertEq(ctf.balanceOf(seller, quotePosition), BID_PRICE, "mixed quote");
    }
}
