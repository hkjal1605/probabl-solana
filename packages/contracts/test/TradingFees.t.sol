// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ConditionalSettlement } from "../src/ConditionalSettlement.sol";
import { OrderValidator } from "../src/OrderValidator.sol";
import {
    Branch,
    FundingKind,
    MarketConfig,
    Order,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { MutableReceiver } from "./AdversarialReceivers.t.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { Vm } from "./TestBase.sol";
import { MockERC20, SixDecimalToken } from "./mocks/MockTokens.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TradingFeesTest is ProtocolFixture {
    uint256 private sequence;

    function testOneGtcOrderCanPayTakerThenMakerFees() public {
        feeVault.setFeeRates(100, 200);
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            2e18,
            uint128(200 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        ask.quantity = 1e18;
        _openPair(bid, ask, false);
        _matchOrders(bid, ask, 1e18);
        ask.salt = keccak256("NEW_RESTING_ASK");
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, 1e18);
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId),
            3e16,
            "same bid pays 200 then 100 bps"
        );
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 197e16, "net after both roles");
    }

    function testFeeEventExactlyMatchesCollectedAssetAmountAndLiquidityRole() public {
        feeVault.setFeeRates(0, 25);
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            uint128(200 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        _openPair(bid, ask, true);
        bytes32 askHash = exchange.hashOrder(ask);
        vm.recordLogs();
        _matchOrders(bid, ask, 1e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(settlement)
                    || logs[i].topics[0]
                        != keccak256(
                            "TradingFeeCharged(bytes32,bytes32,uint256,bool,uint16,uint256,uint256)"
                        )
            ) continue;
            ++found;
            assertEq(logs[i].topics[1], askHash, "fee order hash");
            assertEq(logs[i].topics[2], marketId, "fee market");
            assertEq(uint256(logs[i].topics[3]), market.quoteYesPositionId, "fee asset");
            (bool isMaker, uint16 bps, uint256 gross, uint256 fee) =
                abi.decode(logs[i].data, (bool, uint16, uint256, uint256));
            assertTrue(!isMaker, "seller is taker");
            assertEq(bps, 25, "fee rate");
            assertEq(gross, 200 * _quoteUnit(), "gross proceeds");
            assertEq(
                fee,
                ctf.balanceOf(address(feeVault), market.quoteYesPositionId),
                "event reconciles with vault"
            );
        }
        assertEq(found, 1, "zero maker fee does not create redundant event");
    }

    function _pair(
        Branch branch,
        FundingKind buyFunding,
        FundingKind sellFunding,
        uint128 quantity,
        uint128 bidPrice,
        uint128 askPrice
    ) internal returns (Order memory bid, Order memory ask) {
        bid = _order(
            buyer,
            branch,
            Side.BUY,
            buyFunding,
            quantity,
            bidPrice,
            TimeInForce.GTC,
            0,
            bytes32(++sequence)
        );
        ask = _order(
            seller,
            branch,
            Side.SELL,
            sellFunding,
            quantity,
            askPrice,
            TimeInForce.GTC,
            0,
            bytes32(++sequence)
        );
        bid.maxFeeBps = 1000;
        ask.maxFeeBps = 1000;
        if (buyFunding == FundingKind.ACTIVE_CLAIM) {
            _splitFor(buyer, quote, uint256(quantity) * bidPrice / 1e18);
        }
        if (sellFunding == FundingKind.ACTIVE_CLAIM) _splitFor(seller, stock, quantity);
    }

    function _openPair(
        Order memory bid,
        Order memory ask,
        bool bidIsMaker
    ) internal {
        if (bidIsMaker) {
            _openOrder(bid, _sign(bid, BUYER_KEY));
            _openOrder(ask, _sign(ask, SELLER_KEY));
        } else {
            _openOrder(ask, _sign(ask, SELLER_KEY));
            _openOrder(bid, _sign(bid, BUYER_KEY));
        }
    }

    function testEveryBranchFundingAndMakerDirection() public {
        feeVault.setFeeRates(25, 75);
        for (uint256 mode; mode < 16; ++mode) {
            Branch branch = mode & 1 == 0 ? Branch.YES : Branch.NO;
            FundingKind buyFunding =
                mode & 2 == 0 ? FundingKind.WHOLE_COLLATERAL : FundingKind.ACTIVE_CLAIM;
            FundingKind sellFunding =
                mode & 4 == 0 ? FundingKind.WHOLE_COLLATERAL : FundingKind.ACTIVE_CLAIM;
            bool bidIsMaker = mode & 8 != 0;
            (Order memory bid, Order memory ask) = _pair(
                branch,
                buyFunding,
                sellFunding,
                3e18,
                uint128(220 * _quoteUnit()),
                uint128(200 * _quoteUnit())
            );
            _openPair(bid, ask, bidIsMaker);
            uint256 stockId =
                branch == Branch.YES ? market.stockYesPositionId : market.stockNoPositionId;
            uint256 cashId =
                branch == Branch.YES ? market.quoteYesPositionId : market.quoteNoPositionId;
            uint256 beforeStock = ctf.balanceOf(buyer, stockId);
            uint256 beforeCash = ctf.balanceOf(seller, cashId);
            uint256 vaultStock = ctf.balanceOf(address(feeVault), stockId);
            uint256 vaultCash = ctf.balanceOf(address(feeVault), cashId);
            uint256 executionQuote = (bidIsMaker ? 440 : 400) * _quoteUnit();
            uint256 stockFee = uint256(2e18) * (bidIsMaker ? 25 : 75) / 10000;
            uint256 cashFee = executionQuote * (bidIsMaker ? 75 : 25) / 10000;
            _matchOrders(bid, ask, 2e18);
            assertEq(
                ctf.balanceOf(buyer, stockId) - beforeStock,
                2e18 - stockFee,
                "buyer net received claims"
            );
            assertEq(
                ctf.balanceOf(seller, cashId) - beforeCash,
                executionQuote - cashFee,
                "seller net received claims"
            );
            assertEq(
                ctf.balanceOf(address(feeVault), stockId) - vaultStock,
                stockFee,
                "stock fee received"
            );
            assertEq(
                ctf.balanceOf(address(feeVault), cashId) - vaultCash, cashFee, "cash fee received"
            );
            assertEq(ctf.balanceOf(address(settlement), stockId), 0, "no stock residue");
            assertEq(ctf.balanceOf(address(settlement), cashId), 0, "no cash residue");
            assertEq(
                exchange.getOrderState(exchange.hashOrder(bid)).reserved,
                220 * _quoteUnit(),
                "fee does not affect remaining reservation"
            );
            vm.startPrank(buyer);
            exchange.cancelOrder(exchange.hashOrder(bid));
            vm.stopPrank();
            vm.startPrank(seller);
            exchange.cancelOrder(exchange.hashOrder(ask));
            vm.stopPrank();
            assertEq(exchange.marketOpenNotional(marketId), 0, "counters clear exactly");
        }
    }

    function testFeesNeverTouchInactiveClaimsOrPriceImprovement() public {
        feeVault.setFeeRates(100, 200);
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            2e18,
            uint128(220 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        uint256 beforeQuote = quote.balanceOf(buyer);
        _openPair(bid, ask, false);
        _matchOrders(bid, ask, 1e18);
        assertEq(
            quote.balanceOf(buyer),
            beforeQuote - 420 * _quoteUnit(),
            "20 USDG improvement returned in full"
        );
        assertEq(
            ctf.balanceOf(buyer, market.quoteNoPositionId),
            200 * _quoteUnit(),
            "inactive cash has no fee"
        );
        assertEq(ctf.balanceOf(seller, market.stockNoPositionId), 1e18, "inactive stock has no fee");
        vm.startPrank(buyer);
        exchange.cancelOrder(exchange.hashOrder(bid));
        vm.stopPrank();
        assertEq(
            quote.balanceOf(buyer), beforeQuote - 200 * _quoteUnit(), "all unfilled cash returned"
        );
    }

    function testAdminUpdateEnforcesEachSignedCapAndRevertsAtomically() public {
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            2e18,
            uint128(200 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        bid.maxFeeBps = 10;
        ask.maxFeeBps = 20;
        _openPair(bid, ask, true);
        bytes32 bidHash = exchange.hashOrder(bid);
        bytes32 askHash = exchange.hashOrder(ask);
        feeVault.setFeeRates(11, 20);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConditionalSettlement.FeeExceedsSignedMaximum.selector,
                bidHash,
                uint16(11),
                uint16(10)
            )
        );
        _matchOrders(bid, ask, 1e18);
        feeVault.setFeeRates(10, 21);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConditionalSettlement.FeeExceedsSignedMaximum.selector,
                askHash,
                uint16(21),
                uint16(20)
            )
        );
        _matchOrders(bid, ask, 1e18);
        assertEq(
            exchange.getOrderState(bidHash).remaining, 2e18, "failed fill does not consume quantity"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId),
            0,
            "failed fill has no fees"
        );
        feeVault.setFeeRates(10, 20);
        _matchOrders(bid, ask, 1e18);
        feeVault.setFeeRates(0, 0);
        _matchOrders(bid, ask, 1e18);
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId),
            1e15,
            "later rate change never reprices first fill"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.quoteYesPositionId),
            200 * _quoteUnit() * 20 / 10000,
            "zero fees after update"
        );
    }

    function testTamperingFeeCapInvalidatesSignatureAndExcessCapIsRejected() public {
        (Order memory bid,) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            uint128(200 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        bid.maxFeeBps = 0;
        bytes memory signature = _sign(bid, BUYER_KEY);
        bid.maxFeeBps = 1000;
        vm.expectRevert(OrderValidator.InvalidSignature.selector);
        _openOrder(bid, signature);
        bid.maxFeeBps = 1001;
        signature = _sign(bid, BUYER_KEY);
        vm.expectRevert(OrderValidator.InvalidFeeCap.selector);
        _openOrder(bid, signature);
    }

    function testZeroCapStillProtectsOrdersSignedBeforeRateIncrease() public {
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            uint128(200 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        bid.maxFeeBps = 0;
        ask.maxFeeBps = 0;
        _openPair(bid, ask, true);
        feeVault.setFeeRates(1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConditionalSettlement.FeeExceedsSignedMaximum.selector,
                exchange.hashOrder(bid),
                uint16(1),
                uint16(0)
            )
        );
        _matchOrders(bid, ask, 1e18);
        vm.startPrank(buyer);
        exchange.cancelOrder(exchange.hashOrder(bid));
        vm.stopPrank();
    }

    function _tinyMarket() internal {
        string memory uri = "ipfs://fee-dust";
        MarketConfig memory config = MarketConfig({
            baseToken: address(stock),
            quoteToken: address(quote),
            polymarketConditionId: keccak256("FEE_DUST"),
            polymarketYesIndex: 1,
            polymarketNoIndex: 2,
            tradingOpen: uint64(block.timestamp),
            tradingCutoff: cutoff,
            rulesHash: keccak256("FEE_DUST"),
            metadataHash: keccak256(bytes(uri)),
            priceTickRawX18: 1e18,
            baseStep: 1,
            minNotional: 1,
            maxOrderQuantity: 1_000_000,
            maxOrderNotional: 1_000_000,
            maxWalletOpenNotional: 10_000_000,
            maxMarketOpenNotional: 20_000_000
        });
        marketId = registry.createMarket(config, uri);
        registry.openMarket(marketId);
        market = registry.getMarket(marketId);
    }

    function testDustPartialFillsAndRateChangesCarryWithoutRetroactiveFees() public {
        _tinyMarket();
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            10_000,
            1e18,
            1e18
        );
        _openPair(bid, ask, true);
        feeVault.setFeeRates(1, 2);
        _matchOrders(bid, ask, 3333);
        assertEq(settlement.feeRemainder(exchange.hashOrder(bid)), 3333, "fraction saved");
        feeVault.setFeeRates(0, 0);
        _matchOrders(bid, ask, 1);
        assertEq(
            settlement.feeRemainder(exchange.hashOrder(bid)),
            3333,
            "zero fee does not erase fractional carry"
        );
        feeVault.setFeeRates(2, 3);
        _matchOrders(bid, ask, 6666);
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId), 1, "weighted buyer fee"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.quoteYesPositionId), 2, "weighted seller fee"
        );
        assertEq(settlement.feeRemainder(exchange.hashOrder(bid)), 6665, "buyer final carry");
        assertEq(settlement.feeRemainder(exchange.hashOrder(ask)), 6664, "seller final carry");
    }

    function testIocChargesActualFilledQuantityAndReleasesUnfilledEscrow() public {
        feeVault.setFeeRates(100, 200);
        (Order memory bid, Order memory ask) = _pair(
            Branch.NO,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            3e18,
            uint128(220 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        bid.tif = TimeInForce.IOC;
        _openOrder(ask, _sign(ask, SELLER_KEY));
        Order[] memory makers = new Order[](1);
        makers[0] = ask;
        uint128[] memory quantities = new uint128[](1);
        quantities[0] = 1e18;
        uint256 beforeQuote = quote.balanceOf(buyer);
        _executeIOC(bid, _sign(bid, BUYER_KEY), makers, quantities);
        assertEq(
            quote.balanceOf(buyer), beforeQuote - 200 * _quoteUnit(), "only filled quote spent"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockNoPositionId), 2e16, "IOC taker stock fee"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.quoteNoPositionId),
            2 * _quoteUnit(),
            "resting maker cash fee"
        );
        assertEq(
            uint256(exchange.getOrderState(exchange.hashOrder(bid)).status),
            uint256(OrderStatus.CANCELLED),
            "IOC remainder cancelled"
        );
    }

    function testRejectingRecipientPaysNormalFeesAndReceivesExactNetCredit() public {
        _tinyMarket();
        feeVault.setFeeRates(3, 7);
        MutableReceiver receiver = new MutableReceiver(buyer);
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            10_000,
            1e18,
            1e18
        );
        ask.recipient = address(receiver);
        _openPair(bid, ask, true);
        receiver.setBehavior(true, false);
        _matchOrders(bid, ask, 3333);
        assertEq(settlement.feeRemainder(exchange.hashOrder(bid)), 9999, "buyer carry preserved");
        assertEq(settlement.feeRemainder(exchange.hashOrder(ask)), 3331, "seller carry preserved");
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId),
            0,
            "stock fee below one raw unit"
        );
        assertEq(
            exchange.getOrderState(exchange.hashOrder(bid)).remaining,
            6667,
            "fill consumed normally"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.quoteYesPositionId), 2, "normal fee charged"
        );
        assertEq(
            exchange.payoutVault()
                .claimable(address(receiver), address(ctf), market.quoteYesPositionId),
            3331,
            "only net proceeds credited"
        );
        assertEq(
            ctf.balanceOf(buyer, market.stockYesPositionId), 3333, "counterparty paid normally"
        );
    }

    function testCarriedFeeCanConsumeEntireDustFillWithoutCreatingZeroPayout() public {
        _tinyMarket();
        feeVault.setFeeRates(1000, 1000);
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES, FundingKind.WHOLE_COLLATERAL, FundingKind.WHOLE_COLLATERAL, 10, 1e18, 1e18
        );
        _openPair(bid, ask, true);
        _matchOrders(bid, ask, 9);
        _matchOrders(bid, ask, 1);
        assertEq(ctf.balanceOf(buyer, market.stockYesPositionId), 9, "zero net last fill");
        assertEq(ctf.balanceOf(seller, market.quoteYesPositionId), 9, "zero net quote last fill");
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId), 1, "full carried stock fee"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.quoteYesPositionId), 1, "full carried quote fee"
        );
        assertEq(
            exchange.payoutVault().totalClaimable(address(ctf), market.stockYesPositionId),
            0,
            "no zero credit"
        );
    }

    function testFuzzFeesConserveClaimProceeds(
        uint16 makerSeed,
        uint16 takerSeed,
        uint64 quantitySeed,
        bool bidIsMaker
    ) public {
        uint16 makerBps = makerSeed % 1001;
        uint16 takerBps = takerSeed % 1001;
        feeVault.setFeeRates(makerBps, takerBps);
        uint128 quantity = uint128((uint256(quantitySeed) % 1000 + 1) * market.baseStep);
        (Order memory bid, Order memory ask) = _pair(
            Branch.YES,
            FundingKind.WHOLE_COLLATERAL,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            uint128(200 * _quoteUnit()),
            uint128(200 * _quoteUnit())
        );
        _openPair(bid, ask, bidIsMaker);
        _matchOrders(bid, ask, quantity);
        uint256 stockFee = uint256(quantity) * (bidIsMaker ? makerBps : takerBps) / 10000;
        uint256 cashGross = uint256(quantity) * 200 * _quoteUnit() / 1e18;
        uint256 cashFee = cashGross * (bidIsMaker ? takerBps : makerBps) / 10000;
        assertEq(
            ctf.balanceOf(buyer, market.stockYesPositionId), quantity - stockFee, "fuzz net stock"
        );
        assertEq(
            ctf.balanceOf(seller, market.quoteYesPositionId), cashGross - cashFee, "fuzz net cash"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.stockYesPositionId), stockFee, "fuzz stock fee"
        );
        assertEq(
            ctf.balanceOf(address(feeVault), market.quoteYesPositionId), cashFee, "fuzz cash fee"
        );
        assertEq(stock.balanceOf(address(ctf)), quantity, "full stock backing retained");
        assertEq(quote.balanceOf(address(ctf)), cashGross, "full cash backing retained");
    }
}

/// @dev Same fee paths with real-world USDG precision; no decimal scaling in contracts.
contract SixDecimalTradingFeesTest is TradingFeesTest {
    function _quoteUnit() internal pure override returns (uint256) {
        return 1e6;
    }

    function _newQuoteToken() internal override returns (MockERC20) {
        return new SixDecimalToken();
    }
}
