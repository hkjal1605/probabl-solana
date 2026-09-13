// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ConditionalExchange } from "../src/ConditionalExchange.sol";
import { OrderRecoveryRouter } from "../src/OrderRecoveryRouter.sol";
import { OrderValidator } from "../src/OrderValidator.sol";
import {
    Branch,
    FundingKind,
    MarketConfig,
    Order,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { Mock1271Wallet } from "./mocks/MockTokens.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract SecurityBoundariesTest is ProtocolFixture {
    function _bid() private view returns (Order memory) {
        return _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            210e18,
            TimeInForce.GTC,
            0,
            keccak256("BOUNDARY_BID")
        );
    }

    function testChangedRecipientChainAndExchangeDomainCannotUseAnExistingSignature() public {
        Order memory order = _bid();
        bytes memory signature = _sign(order, BUYER_KEY);
        order.recipient = secondBuyer;
        vm.expectRevert(OrderValidator.InvalidSignature.selector);
        _openOrder(order, signature);
        order.recipient = buyer;
        uint256 chain = vm.getChainId();
        vm.chainId(chain + 1);
        vm.expectRevert(OrderValidator.InvalidSignature.selector);
        _openOrder(order, signature);
        vm.chainId(chain);
        OrderValidator otherDomain = new OrderValidator(address(positionRouter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, otherDomain.hashOrder(order));
        bytes memory wrongDomain = abi.encodePacked(r, s, v);
        vm.expectRevert(OrderValidator.InvalidSignature.selector);
        _openOrder(order, wrongDomain);
        vm.expectRevert(OrderValidator.InvalidSignature.selector);
        _openOrder(order, "");
        assertEq(exchange.marketOpenNotional(marketId), 0, "no unauthorized reservation");
        assertEq(quote.balanceOf(address(exchange)), 0, "no unauthorized pull");
        _openOrder(order, signature);
    }

    function testMalformedOrRevertingERC1271CannotCreateEscrow() public {
        Mock1271Wallet wallet = new Mock1271Wallet(buyer);
        quote.mint(address(wallet), 210e18);
        wallet.approveToken(quote, address(exchange));
        Order memory order = _bid();
        order.maker = address(wallet);
        bytes memory signature = _sign(order, BUYER_KEY);
        bytes memory selector = abi.encodeWithSelector(IERC1271.isValidSignature.selector);
        for (uint256 mode; mode < 3; ++mode) {
            if (mode == 0) {
                vm.mockCall(address(wallet), selector, hex"1626ba7e");
            } else if (mode == 1) {
                vm.mockCall(address(wallet), selector, abi.encode(bytes32(uint256(1))));
            } else {
                vm.mockCallRevert(address(wallet), selector, "SIGNER_REVERTED");
            }
            vm.expectRevert(OrderValidator.InvalidSignature.selector);
            _openOrder(order, signature);
            vm.clearMockedCalls();
            assertEq(quote.balanceOf(address(wallet)), 210e18, "wallet funding unchanged");
            assertEq(exchange.marketOpenNotional(marketId), 0, "no open order");
        }
        _openOrder(order, signature);
    }

    function testOrdersFromDifferentMarketsCannotConsumeEachOthersEscrow() public {
        string memory uri = "ipfs://independent-market";
        MarketConfig memory config = MarketConfig({
            baseToken: address(stock),
            quoteToken: address(quote),
            polymarketConditionId: keccak256("SECOND_EVENT"),
            polymarketYesIndex: 1,
            polymarketNoIndex: 2,
            tradingOpen: market.tradingOpen,
            tradingCutoff: market.tradingCutoff,
            rulesHash: market.rulesHash,
            metadataHash: keccak256(bytes(uri)),
            priceTickRawX18: market.priceTickRawX18,
            baseStep: market.baseStep,
            minNotional: market.minNotional,
            maxOrderQuantity: market.maxOrderQuantity,
            maxOrderNotional: market.maxOrderNotional,
            maxWalletOpenNotional: market.maxWalletOpenNotional,
            maxMarketOpenNotional: market.maxMarketOpenNotional
        });
        bytes32 otherMarket = registry.createMarket(config, uri);
        registry.openMarket(otherMarket);
        Order memory bid = _bid();
        bid.marketId = otherMarket;
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            0,
            keccak256("FIRST_MARKET_ASK")
        );
        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        bytes32 askHash = _openOrder(ask, _sign(ask, SELLER_KEY));
        vm.expectRevert(ConditionalExchange.InvalidFill.selector);
        _matchOrders(bid, ask, 1e18);
        assertEq(exchange.marketOpenNotional(marketId), 200e18, "first market isolated");
        assertEq(exchange.marketOpenNotional(otherMarket), 210e18, "second market isolated");
        vm.prank(buyer);
        exchange.cancelOrder(bidHash);
        assertEq(exchange.marketOpenNotional(otherMarket), 0, "second market released");
        assertEq(exchange.getOrderState(askHash).reserved, 1e18, "first maker escrow unchanged");
    }

    function testRecoveryBatchAndMakerRedirectRejectInvalidBoundaries() public {
        for (uint256 i; i < 2; ++i) {
            bytes32[] memory invalid = new bytes32[](i == 0 ? 0 : 65);
            vm.expectRevert(OrderRecoveryRouter.InvalidBatchLength.selector);
            recoveryRouter.releaseExpired(invalid);
            vm.expectRevert(OrderRecoveryRouter.InvalidBatchLength.selector);
            recoveryRouter.releaseInvalidated(invalid);
            vm.expectRevert(OrderRecoveryRouter.InvalidBatchLength.selector);
            recoveryRouter.releaseClosedMarkets(invalid);
        }
        Order memory bid = _bid();
        bytes32 hash = _openOrder(bid, _sign(bid, BUYER_KEY));
        vm.prank(buyer);
        vm.expectRevert(ConditionalExchange.InvalidAddress.selector);
        exchange.cancelOrderTo(hash, address(0));
        vm.prank(buyer);
        vm.expectRevert(ConditionalExchange.InvalidAddress.selector);
        exchange.cancelOrderTo(hash, address(exchange));
        uint256 beforeBalance = quote.balanceOf(secondBuyer);
        vm.prank(buyer);
        exchange.cancelOrderTo(hash, secondBuyer);
        assertEq(
            quote.balanceOf(secondBuyer),
            beforeBalance + 210e18,
            "exact maker-authorized destination"
        );
        vm.prank(buyer);
        vm.expectRevert();
        exchange.cancelOrderTo(hash, secondBuyer);
    }
}
