// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ConditionalExchange } from "../src/ConditionalExchange.sol";
import { ConditionalSettlement } from "../src/ConditionalSettlement.sol";
import { IAtomicOrderRouter } from "../src/interfaces/IAtomicOrderRouter.sol";
import { IConditionalSettlement } from "../src/interfaces/IConditionalSettlement.sol";
import { IConditionalTokens } from "../src/interfaces/IConditionalTokens.sol";
import { IProtocolAuthority } from "../src/interfaces/IProtocolAuthority.sol";
import { ProtocolConstants } from "../src/libraries/ProtocolConstants.sol";
import {
    Branch,
    FundingKind,
    Market,
    MarketConfig,
    Order,
    OrderStatus,
    SettlementFill,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { FalseReturnToken, NoReturnToken } from "./mocks/MockTokens.sol";

contract ExchangeValidationTest is ProtocolFixture {
    uint128 private constant QUANTITY = 1e18;
    uint128 private constant BID = 210e18;
    uint128 private constant ASK = 200e18;

    function testOnlyAtomicRouterCanCallSettlementKernel() public {
        (Order memory bid, Order memory ask,,) = _openPair(1, Branch.YES, BID, ASK);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        exchange.matchOrders(bid, ask, QUANTITY);
    }

    function testNonCrossingAndWrongBranchCannotFill() public {
        (Order memory nonCrossingBid, Order memory expensiveAsk,,) =
            _openPair(2, Branch.YES, 199e18, ASK);
        vm.expectRevert();
        _matchOrders(nonCrossingBid, expensiveAsk, QUANTITY);

        Order memory noAsk = _order(
            seller,
            Branch.NO,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            ASK,
            TimeInForce.GTC,
            3,
            keccak256("NO_ASK_VALIDATION")
        );
        _openOrder(noAsk, _sign(noAsk, SELLER_KEY));
        vm.expectRevert();
        _matchOrders(nonCrossingBid, noAsk, QUANTITY);
    }

    function testOrderTickStepExpiryAndReplayValidation() public {
        Order memory badTick = _buy(4, BID + 1, QUANTITY, keccak256("BAD_TICK"));
        bytes memory badTickSignature = _sign(badTick, BUYER_KEY);
        vm.expectRevert();
        _openOrder(badTick, badTickSignature);

        Order memory badStep = _buy(5, BID, QUANTITY + 1, keccak256("BAD_STEP"));
        bytes memory badStepSignature = _sign(badStep, BUYER_KEY);
        vm.expectRevert();
        _openOrder(badStep, badStepSignature);

        Order memory expired = _buy(6, BID, QUANTITY, keccak256("EXPIRED_AT_OPEN"));
        expired.expiry = uint64(block.timestamp);
        bytes memory expiredSignature = _sign(expired, BUYER_KEY);
        vm.expectRevert();
        _openOrder(expired, expiredSignature);

        Order memory valid = _buy(7, BID, QUANTITY, keccak256("REPLAY"));
        bytes memory validSignature = _sign(valid, BUYER_KEY);
        _openOrder(valid, validSignature);
        vm.expectRevert();
        _openOrder(valid, validSignature);
    }

    function testOnlyMakerCanCancel() public {
        Order memory bid = _buy(8, BID, QUANTITY, keccak256("MAKER_CANCEL"));
        bytes32 orderHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        vm.prank(seller);
        vm.expectRevert();
        exchange.cancelOrder(orderHash);
        assertEq(
            uint256(exchange.getOrderState(orderHash).status),
            uint256(OrderStatus.OPEN),
            "unauthorized cancel changed state"
        );
    }

    function testPauseBlocksOpenAndFillButNotExistingEscrowRecovery() public {
        (Order memory bid, Order memory ask, bytes32 bidHash, bytes32 askHash) =
            _openPair(9, Branch.YES, BID, ASK);
        exchange.setTradingPaused(true, keccak256("VALIDATION_PAUSE"));

        vm.expectRevert();
        _matchOrders(bid, ask, QUANTITY);
        Order memory newBid = _buy(10, BID, QUANTITY, keccak256("PAUSED_OPEN"));
        bytes memory signature = _sign(newBid, BUYER_KEY);
        vm.expectRevert();
        _openOrder(newBid, signature);

        vm.prank(buyer);
        exchange.cancelOrder(bidHash);
        vm.prank(seller);
        exchange.cancelOrder(askHash);
    }

    function testIocMakerLimitIsEnforcedBeforeFunding() public {
        Order memory taker = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            BID,
            TimeInForce.IOC,
            11,
            keccak256("TOO_MANY_IOC")
        );
        bytes memory signature = _sign(taker, BUYER_KEY);
        Order[] memory makers = new Order[](33);
        uint128[] memory quantities = new uint128[](33);
        vm.expectRevert();
        _executeIOC(taker, signature, makers, quantities);
        assertEq(
            uint256(exchange.getOrderState(exchange.hashOrder(taker)).status),
            uint256(OrderStatus.NONE),
            "oversized IOC opened"
        );
    }

    function testIocRevertsAtomicallyWhenAnyMakerIsStale() public {
        Order memory maker = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            ASK,
            TimeInForce.GTC,
            12,
            keccak256("LIVE_IOC_MAKER")
        );
        bytes32 makerHash = _openOrder(maker, _sign(maker, SELLER_KEY));
        Order memory stale = maker;
        stale.nonce = 13;
        stale.salt = keccak256("STALE_IOC_MAKER");
        Order memory taker = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            2e18,
            BID,
            TimeInForce.IOC,
            12,
            keccak256("ATOMIC_IOC_TAKER")
        );
        bytes memory signature = _sign(taker, BUYER_KEY);
        Order[] memory makers = new Order[](2);
        makers[0] = maker;
        makers[1] = stale;
        uint128[] memory quantities = new uint128[](2);
        quantities[0] = QUANTITY;
        quantities[1] = QUANTITY;

        vm.expectRevert();
        _executeIOC(taker, signature, makers, quantities);

        assertEq(
            uint256(exchange.getOrderState(makerHash).status),
            uint256(OrderStatus.OPEN),
            "maker fill was not rolled back"
        );
        assertEq(
            uint256(exchange.getOrderState(exchange.hashOrder(taker)).status),
            uint256(OrderStatus.NONE),
            "taker open was not rolled back"
        );
    }

    function testSettlementAndIocInternalsRejectDirectCalls() public {
        SettlementFill memory fill = SettlementFill({
            marketId: marketId,
            buyerMaker: buyer,
            buyerRecipient: buyer,
            sellerMaker: seller,
            sellerRecipient: seller,
            fillQuantity: QUANTITY,
            executionQuote: ASK,
            branch: Branch.YES,
            buyFundingKind: FundingKind.WHOLE_COLLATERAL,
            sellFundingKind: FundingKind.WHOLE_COLLATERAL,
            buyOrderHash: bytes32(0),
            sellOrderHash: bytes32(0),
            buyMaxFeeBps: 0,
            sellMaxFeeBps: 0,
            bidIsMaker: true
        });
        vm.expectRevert();
        settlement.settleFill(fill);

        Order memory ioc = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            BID,
            TimeInForce.IOC,
            14,
            keccak256("DIRECT_IOC")
        );
        bytes memory signature = _sign(ioc, BUYER_KEY);
        vm.expectRevert();
        exchange.openOrder(ioc, signature);
    }

    function testOneTimeComponentConfigurationCannotChange() public {
        vm.expectRevert();
        exchange.configureOrderValidator(validator);
        vm.expectRevert();
        exchange.configureSettlement(IConditionalSettlement(address(settlement)));
        vm.expectRevert();
        exchange.configureAtomicRouter(IAtomicOrderRouter(address(atomicRouter)));
    }

    function testAssetContractsRejectMismatchedConditionalTokens() public {
        IConditionalTokens wrongCtf = IConditionalTokens(address(stock));
        vm.expectRevert();
        new ConditionalExchange(wrongCtf, registry, IProtocolAuthority(address(authority)));
        vm.expectRevert();
        new ConditionalSettlement(wrongCtf, registry, address(exchange), feeVault);
    }

    function testOrderWalletAndMarketRiskCapsAreEnforced() public {
        string memory uri = "ipfs://conditional-stocks/capped-market";
        MarketConfig memory config = _cappedMarketConfig(address(stock), uri);
        bytes32 cappedMarketId = registry.createMarket(config, uri);
        registry.openMarket(cappedMarketId);

        Order memory tooSmall =
            _marketBuy(cappedMarketId, buyer, 1, uint128(1e18), uint128(1e18), "TOO_SMALL");
        bytes memory tooSmallSignature = _sign(tooSmall, BUYER_KEY);
        vm.expectRevert();
        _openOrder(tooSmall, tooSmallSignature);

        Order memory tooLarge =
            _marketBuy(cappedMarketId, buyer, 2, uint128(1e18), uint128(201e18), "TOO_LARGE");
        bytes memory tooLargeSignature = _sign(tooLarge, BUYER_KEY);
        vm.expectRevert();
        _openOrder(tooLarge, tooLargeSignature);

        Order memory first =
            _marketBuy(cappedMarketId, buyer, 3, QUANTITY, uint128(200e18), "CAP_FIRST");
        _openOrder(first, _sign(first, BUYER_KEY));

        Order memory walletOverflow =
            _marketBuy(cappedMarketId, buyer, 4, QUANTITY, uint128(200e18), "WALLET_CAP");
        bytes memory walletOverflowSignature = _sign(walletOverflow, BUYER_KEY);
        vm.expectRevert();
        _openOrder(walletOverflow, walletOverflowSignature);

        Order memory second =
            _marketBuy(cappedMarketId, secondBuyer, 3, QUANTITY, uint128(200e18), "CAP_SECOND");
        _openOrder(second, _sign(second, SECOND_BUYER_KEY));

        Order memory marketOverflow =
            _marketBuy(cappedMarketId, seller, 3, QUANTITY, uint128(200e18), "MARKET_CAP");
        bytes memory marketOverflowSignature = _sign(marketOverflow, SELLER_KEY);
        vm.expectRevert();
        _openOrder(marketOverflow, marketOverflowSignature);
    }

    function testFalseReturnTokenCannotOpenAnOrder() public {
        FalseReturnToken token = new FalseReturnToken();
        string memory uri = "ipfs://conditional-stocks/false-return-market";
        MarketConfig memory config = _cappedMarketConfig(address(token), uri);
        bytes32 tokenMarketId = registry.createMarket(config, uri);
        registry.openMarket(tokenMarketId);
        token.mint(seller, QUANTITY);
        vm.prank(seller);
        token.approve(address(exchange), type(uint256).max);

        Order memory ask = _marketSell(tokenMarketId, seller, 20, "FALSE_RETURN");
        bytes memory signature = _sign(ask, SELLER_KEY);
        vm.expectRevert();
        _openOrder(ask, signature);
        assertEq(token.balanceOf(address(exchange)), 0, "false-return token entered escrow");
    }

    function testNoReturnTokenFailsCtfSettlementAtomicallyAndEscrowRemainsRecoverable() public {
        NoReturnToken token = new NoReturnToken();
        string memory uri = "ipfs://conditional-stocks/no-return-market";
        MarketConfig memory config = _cappedMarketConfig(address(token), uri);
        bytes32 tokenMarketId = registry.createMarket(config, uri);
        registry.openMarket(tokenMarketId);
        Market memory tokenMarket = registry.getMarket(tokenMarketId);
        token.mint(seller, QUANTITY);
        vm.prank(seller);
        token.approve(address(exchange), type(uint256).max);

        Order memory bid =
            _marketBuy(tokenMarketId, buyer, 21, QUANTITY, uint128(200e18), "NO_RETURN_BID");
        Order memory ask = _marketSell(tokenMarketId, seller, 21, "NO_RETURN_ASK");
        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        bytes32 askHash = _openOrder(ask, _sign(ask, SELLER_KEY));
        vm.expectRevert();
        _matchOrders(bid, ask, QUANTITY);

        assertEq(
            uint256(exchange.getOrderState(bidHash).status),
            uint256(OrderStatus.OPEN),
            "failed fill changed bid"
        );
        assertEq(
            uint256(exchange.getOrderState(askHash).status),
            uint256(OrderStatus.OPEN),
            "failed fill changed ask"
        );
        assertEq(
            ctf.balanceOf(buyer, tokenMarket.stockYesPositionId), 0, "failed fill minted a claim"
        );
        vm.prank(buyer);
        exchange.cancelOrder(bidHash);
        vm.prank(seller);
        exchange.cancelOrder(askHash);
        assertEq(token.balanceOf(seller), QUANTITY, "seller could not recover no-return escrow");
        assertEq(token.balanceOf(address(settlement)), 0, "settlement retained no-return token");
    }

    function _openPair(
        uint64 nonce,
        Branch branch,
        uint128 bidPrice,
        uint128 askPrice
    ) private returns (Order memory bid, Order memory ask, bytes32 bidHash, bytes32 askHash) {
        bid = _order(
            buyer,
            branch,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            bidPrice,
            TimeInForce.GTC,
            nonce,
            keccak256(abi.encode("VALIDATION_BID", nonce))
        );
        ask = _order(
            seller,
            branch,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            askPrice,
            TimeInForce.GTC,
            nonce,
            keccak256(abi.encode("VALIDATION_ASK", nonce))
        );
        bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        askHash = _openOrder(ask, _sign(ask, SELLER_KEY));
    }

    function _buy(
        uint64 nonce,
        uint128 price,
        uint128 quantity,
        bytes32 salt
    ) private view returns (Order memory) {
        return _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            quantity,
            price,
            TimeInForce.GTC,
            nonce,
            salt
        );
    }

    function _cappedMarketConfig(
        address baseToken,
        string memory uri
    ) private view returns (MarketConfig memory) {
        return MarketConfig({
            baseToken: baseToken,
            quoteToken: address(quote),
            polymarketConditionId: keccak256(bytes(uri)),
            polymarketYesIndex: ProtocolConstants.YES_INDEX_SET,
            polymarketNoIndex: ProtocolConstants.NO_INDEX_SET,
            tradingOpen: uint64(block.timestamp),
            tradingCutoff: cutoff,
            rulesHash: keccak256(abi.encode("RULES", uri)),
            metadataHash: keccak256(bytes(uri)),
            priceTickRawX18: uint128(1e18),
            baseStep: QUANTITY,
            minNotional: uint128(100e18),
            maxOrderQuantity: QUANTITY,
            maxOrderNotional: uint128(200e18),
            maxWalletOpenNotional: uint128(300e18),
            maxMarketOpenNotional: uint128(500e18)
        });
    }

    function _marketBuy(
        bytes32 targetMarketId,
        address maker,
        uint64 nonce,
        uint128 quantity,
        uint128 price,
        string memory salt
    ) private view returns (Order memory) {
        return Order({
            maker: maker,
            recipient: maker,
            marketId: targetMarketId,
            branch: Branch.YES,
            side: Side.BUY,
            fundingKind: FundingKind.WHOLE_COLLATERAL,
            quantity: quantity,
            limitPriceRawX18: price,
            tif: TimeInForce.GTC,
            expiry: cutoff - 1,
            nonce: nonce,
            salt: keccak256(bytes(salt)),
            maxFeeBps: 0
        });
    }

    function _marketSell(
        bytes32 targetMarketId,
        address maker,
        uint64 nonce,
        string memory salt
    ) private view returns (Order memory) {
        Order memory order =
            _marketBuy(targetMarketId, maker, nonce, QUANTITY, uint128(200e18), salt);
        order.side = Side.SELL;
        return order;
    }
}
