// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ManualResolutionController } from "../src/ManualResolutionController.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";
import { ProtocolConstants } from "../src/libraries/ProtocolConstants.sol";
import {
    Branch,
    FundingKind,
    MarketConfig,
    MarketState,
    Order,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { FeeOnTransferToken, MockERC20, SixDecimalToken } from "./mocks/MockTokens.sol";

contract MarketResolutionAndPositionsTest is ProtocolFixture {
    function testMarketIdentityAndLifecycleAreDeterministic() public view {
        assertEq(marketId, registry.computeMarketId(_marketConfig()), "market id");
        assertEq(uint256(market.state), uint256(MarketState.OPEN), "market open");
        assertEq(
            ctf.getConditionId(address(resolutionController), market.localQuestionId, 2),
            market.conditionId,
            "condition id"
        );
    }

    function testUnauthorizedRolesCannotCreateFreezeOrResolve() public {
        address outsider = address(0xBAD);
        vm.startPrank(outsider);
        vm.expectRevert();
        registry.createMarket(_marketConfig(), "ipfs://conditional-stocks/test-market");
        vm.expectRevert();
        registry.freezeMarket(marketId, keccak256("UNAUTHORIZED"));
        vm.expectRevert();
        resolutionController.resolveMarket(
            marketId, 1, 0, 1, keccak256("EVIDENCE"), "ipfs://evidence"
        );
        vm.stopPrank();
    }

    function testFreezeMakesOpenEscrowPermissionlesslyReleasable() public {
        uint256 beforeBalance = quote.balanceOf(buyer);
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            10,
            keccak256("FROZEN_ORDER")
        );
        bytes32 orderHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        registry.freezeMarket(marketId, keccak256("EVENT_KNOWN"));

        vm.prank(address(0xBEEF));
        exchange.releaseClosedMarketOrder(orderHash);

        assertEq(quote.balanceOf(buyer), beforeBalance, "all escrow returned");
        assertEq(
            uint256(exchange.getOrderState(orderHash).status),
            uint256(OrderStatus.CANCELLED),
            "order released"
        );
    }

    function testBestEffortRecoveryBatchSkipsInvalidEntries() public {
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            30,
            keccak256("BATCH_RELEASE")
        );
        bytes32 validHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        registry.freezeMarket(marketId, keccak256("BATCH_FREEZE"));
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = keccak256("NOT_AN_ORDER");
        hashes[1] = validHash;

        recoveryRouter.releaseClosedMarkets(hashes);

        assertEq(
            uint256(exchange.getOrderState(validHash).status),
            uint256(OrderStatus.CANCELLED),
            "valid entry released despite stale neighbor"
        );
    }

    function testMergeCompleteSetBeforeResolutionAndMultiplierChange() public {
        uint256 amount = 3e18;
        uint256 quoteBefore = quote.balanceOf(buyer);
        _splitFor(buyer, quote, amount);
        uint256 afterSplit = quote.balanceOf(buyer);

        vm.prank(buyer);
        uint256 returned = positionRouter.mergeForUser(quote, market.conditionId, amount, buyer);
        assertEq(returned, amount, "merge output");
        assertEq(quote.balanceOf(buyer), quoteBefore, "quote conserved");

        uint256 stockBefore = stock.balanceOf(buyer);
        _splitFor(buyer, stock, amount);
        stock.setMultiplierX18(1.25e18);
        vm.prank(buyer);
        positionRouter.mergeForUser(stock, market.conditionId, amount, buyer);
        assertEq(stock.balanceOf(buyer), stockBefore, "raw stock conserved");
        assertTrue(afterSplit == quoteBefore - amount, "split locked exact raw quote");
    }

    function testManualYesResolutionAndWinningClaimRedemption() public {
        uint256 amount = 2e18;
        _splitFor(buyer, stock, amount);
        _resolve(1, 0, 1);

        uint256 recipientBefore = stock.balanceOf(secondBuyer);
        uint256[] memory indexSets = _singleton(ProtocolConstants.YES_INDEX_SET);
        uint256[] memory amounts = _singleton(amount);
        vm.prank(buyer);
        uint256 payout = positionRouter.redeemForUser(
            stock, market.conditionId, indexSets, amounts, secondBuyer
        );

        assertEq(payout, amount, "YES payout");
        assertEq(stock.balanceOf(secondBuyer), recipientBefore + amount, "recipient paid");
        assertEq(
            uint256(registry.marketState(marketId)), uint256(MarketState.REDEEMABLE), "redeemable"
        );
    }

    function testManualNoResolutionAndDirectCtfRedemption() public {
        uint256 amount = 2e18;
        uint256 buyerBefore = stock.balanceOf(buyer);
        _splitFor(buyer, stock, amount);
        _resolve(0, 1, 1);

        uint256[] memory indexSets = new uint256[](2);
        indexSets[0] = ProtocolConstants.YES_INDEX_SET;
        indexSets[1] = ProtocolConstants.NO_INDEX_SET;
        vm.prank(buyer);
        ctf.redeemPositions(
            stock, ProtocolConstants.PARENT_COLLECTION_ID, market.conditionId, indexSets
        );

        assertEq(stock.balanceOf(buyer), buyerBefore, "direct redemption conserved collateral");
    }

    function testInvalidResolutionPaysHalfPerClaim() public {
        uint256 amount = 2e18;
        _splitFor(buyer, quote, amount);
        _resolve(1, 1, 2);

        uint256 beforeBalance = quote.balanceOf(secondBuyer);
        vm.prank(buyer);
        uint256 payoutYes = positionRouter.redeemForUser(
            quote,
            market.conditionId,
            _singleton(ProtocolConstants.YES_INDEX_SET),
            _singleton(amount),
            secondBuyer
        );
        vm.prank(buyer);
        uint256 payoutNo = positionRouter.redeemForUser(
            quote,
            market.conditionId,
            _singleton(ProtocolConstants.NO_INDEX_SET),
            _singleton(amount),
            secondBuyer
        );

        assertEq(payoutYes, amount / 2, "invalid YES half payout");
        assertEq(payoutNo, amount / 2, "invalid NO half payout");
        assertEq(quote.balanceOf(secondBuyer), beforeBalance + amount, "invalid total conserved");
    }

    function testResolutionRejectsMalformedAndSecondSubmission() public {
        registry.freezeMarket(marketId, keccak256("CUTOFF"));
        registry.beginResolution(
            marketId,
            resolutionController.hashResolution(
                marketId, 1, 0, 1, keccak256("EVIDENCE"), "ipfs://evidence"
            )
        );

        vm.expectRevert(ManualResolutionController.InvalidPayoutVector.selector);
        resolutionController.resolveMarket(
            marketId, 2, 0, 2, keccak256("EVIDENCE"), "ipfs://evidence"
        );
        resolutionController.resolveMarket(
            marketId, 1, 0, 1, keccak256("EVIDENCE"), "ipfs://evidence"
        );
        vm.expectRevert(
            abi.encodeWithSelector(ManualResolutionController.AlreadyResolved.selector, marketId)
        );
        resolutionController.resolveMarket(
            marketId, 1, 0, 1, keccak256("EVIDENCE_2"), "ipfs://evidence-2"
        );
    }

    function testLifecycleRejectsInvalidTransitionsAndAllowsPublicCutoffFreeze() public {
        vm.expectRevert();
        registry.openMarket(marketId);
        vm.expectRevert();
        registry.beginResolution(marketId, keccak256("TOO_EARLY"));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.markResolved(marketId);

        vm.warp(cutoff);
        vm.prank(address(0xBEEF));
        registry.freezeAtCutoff(marketId);
        assertEq(uint256(registry.marketState(marketId)), uint256(MarketState.FROZEN), "frozen");
        vm.expectRevert();
        registry.openMarket(marketId);
        registry.beginResolution(marketId, keccak256("READY"));
        vm.expectRevert();
        registry.archiveMarket(marketId, keccak256("EARLY_ARCHIVE"));
    }

    function testResolutionRequiresEvidenceAndAwaitingState() public {
        vm.expectRevert(ManualResolutionController.EmptyEvidence.selector);
        resolutionController.resolveMarket(marketId, 1, 0, 1, bytes32(0), "");
        vm.expectRevert();
        resolutionController.resolveMarket(
            marketId, 1, 0, 1, keccak256("EVIDENCE"), "ipfs://evidence"
        );
    }

    function testOnlyConfiguredCtfOracleCanResolvePreparedCondition() public {
        uint256[] memory payouts = new uint256[](2);
        payouts[0] = 1;
        vm.prank(buyer);
        vm.expectRevert();
        ctf.reportPayouts(market.localQuestionId, payouts);
    }

    function testRegistryRejectsInvalidIndexesTimesAndCaps() public {
        string memory uri = "ipfs://conditional-stocks/test-market";
        MarketConfig memory invalidIndexes = _marketConfig();
        invalidIndexes.polymarketYesIndex = 3;
        vm.expectRevert();
        registry.createMarket(invalidIndexes, uri);

        MarketConfig memory invalidTime = _marketConfig();
        invalidTime.tradingCutoff = invalidTime.tradingOpen;
        vm.expectRevert();
        registry.createMarket(invalidTime, uri);

        MarketConfig memory invalidCaps = _marketConfig();
        invalidCaps.maxWalletOpenNotional = invalidCaps.maxOrderNotional - 1;
        vm.expectRevert();
        registry.createMarket(invalidCaps, uri);
    }

    function testPositionRouterRejectsMalformedRequests() public {
        vm.expectRevert();
        positionRouter.mergeForUser(quote, market.conditionId, 0, buyer);

        uint256[] memory duplicateSets = new uint256[](2);
        duplicateSets[0] = ProtocolConstants.YES_INDEX_SET;
        duplicateSets[1] = ProtocolConstants.YES_INDEX_SET;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1;
        amounts[1] = 1;
        vm.prank(buyer);
        vm.expectRevert();
        positionRouter.redeemForUser(quote, market.conditionId, duplicateSets, amounts, buyer);
    }

    function testRecoveryBatchesHandleExpiredAndInvalidatedOrders() public {
        Order memory expired = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            31,
            keccak256("BATCH_EXPIRED")
        );
        expired.expiry = uint64(block.timestamp + 1);
        bytes32 expiredHash = _openOrder(expired, _sign(expired, BUYER_KEY));
        vm.warp(block.timestamp + 1);
        bytes32[] memory expiredHashes = new bytes32[](1);
        expiredHashes[0] = expiredHash;
        recoveryRouter.releaseExpired(expiredHashes);

        Order memory invalidated = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            32,
            keccak256("BATCH_INVALIDATED")
        );
        bytes32 invalidatedHash = _openOrder(invalidated, _sign(invalidated, BUYER_KEY));
        vm.prank(buyer);
        exchange.cancelUpTo(33);
        bytes32[] memory invalidatedHashes = new bytes32[](1);
        invalidatedHashes[0] = invalidatedHash;
        recoveryRouter.releaseInvalidated(invalidatedHashes);

        assertEq(
            uint256(exchange.getOrderState(expiredHash).status),
            uint256(OrderStatus.CANCELLED),
            "expired batch"
        );
        assertEq(
            uint256(exchange.getOrderState(invalidatedHash).status),
            uint256(OrderStatus.CANCELLED),
            "invalidated batch"
        );
    }

    /// forge-config: default.fuzz.runs = 64
    /// forge-config: ci.fuzz.runs = 256
    function testFuzzSplitAndMergeConserveRawCollateral(
        uint96 rawAmount
    ) public {
        uint256 amount = (uint256(rawAmount) % 10_000 + 1) * 0.001e18;
        uint256 beforeBalance = quote.balanceOf(buyer);
        _splitFor(buyer, quote, amount);
        vm.prank(buyer);
        uint256 returned = positionRouter.mergeForUser(quote, market.conditionId, amount, buyer);

        assertEq(returned, amount, "fuzz merge output");
        assertEq(quote.balanceOf(buyer), beforeBalance, "fuzz raw conservation");
        assertEq(ctf.balanceOf(buyer, market.quoteYesPositionId), 0, "fuzz YES burned");
        assertEq(ctf.balanceOf(buyer, market.quoteNoPositionId), 0, "fuzz NO burned");
    }

    function testUnsolicitedClaimsCannotPolluteExchange() public {
        uint256 amount = 1e18;
        _splitFor(buyer, stock, amount);
        vm.startPrank(buyer);
        vm.expectRevert();
        ctf.safeTransferFrom(buyer, address(exchange), market.stockYesPositionId, amount, "");
        vm.stopPrank();
        assertEq(ctf.balanceOf(address(exchange), market.stockYesPositionId), 0, "no claim stuck");
    }

    function testRegistryRejectsWrongQuoteAndAcceptsSixDecimalBase() public {
        MockERC20 otherQuote = new MockERC20("Other", "OTHER");
        MarketConfig memory wrongQuote = _marketConfig();
        wrongQuote.quoteToken = address(otherQuote);
        vm.expectRevert(MarketRegistry.InvalidMarketConfig.selector);
        registry.createMarket(wrongQuote, "ipfs://conditional-stocks/test-market");

        SixDecimalToken sixDecimal = new SixDecimalToken();
        MarketConfig memory wrongDecimals = _marketConfig();
        wrongDecimals.baseToken = address(sixDecimal);
        bytes32 id = registry.createMarket(wrongDecimals, "ipfs://conditional-stocks/test-market");
        assertEq(
            registry.getMarket(id).baseToken, address(sixDecimal), "raw units support any decimals"
        );
    }

    function testFeeOnTransferCollateralIsRejectedWithoutOpeningOrder() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        string memory uri = "ipfs://conditional-stocks/fee-token-market";
        MarketConfig memory config = _marketConfig();
        config.baseToken = address(feeToken);
        config.polymarketConditionId = keccak256("FEE_TOKEN_EVENT");
        config.rulesHash = keccak256("FEE_TOKEN_RULES");
        config.metadataHash = keccak256(bytes(uri));
        bytes32 feeMarketId = registry.createMarket(config, uri);
        registry.openMarket(feeMarketId);

        feeToken.mint(seller, 10e18);
        vm.prank(seller);
        feeToken.approve(address(exchange), type(uint256).max);
        Order memory ask = Order({
            maker: seller,
            recipient: seller,
            marketId: feeMarketId,
            branch: Branch.YES,
            side: Side.SELL,
            fundingKind: FundingKind.WHOLE_COLLATERAL,
            quantity: 1e18,
            limitPriceRawX18: 200e18,
            tif: TimeInForce.GTC,
            expiry: cutoff - 1,
            nonce: 20,
            salt: keccak256("FEE_TOKEN_ASK"),
            maxFeeBps: 0
        });
        bytes memory signature = _sign(ask, SELLER_KEY);

        vm.expectRevert();
        _openOrder(ask, signature);
        assertEq(feeToken.balanceOf(address(exchange)), 0, "failed open leaves no fee token");
    }

    function _resolve(
        uint256 yes,
        uint256 no,
        uint256 denominator
    ) private {
        registry.freezeMarket(marketId, keccak256("CUTOFF"));
        registry.beginResolution(
            marketId,
            resolutionController.hashResolution(
                marketId,
                yes,
                no,
                denominator,
                keccak256(abi.encode(marketId, yes, no, denominator)),
                "ipfs://resolution-packet"
            )
        );
        resolutionController.resolveMarket(
            marketId,
            yes,
            no,
            denominator,
            keccak256(abi.encode(marketId, yes, no, denominator)),
            "ipfs://resolution-packet"
        );
    }

    function _singleton(
        uint256 value
    ) private pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = value;
    }

    function _marketConfig() private view returns (MarketConfig memory config) {
        string memory metadataUri = "ipfs://conditional-stocks/test-market";
        config = MarketConfig({
            baseToken: address(stock),
            quoteToken: address(quote),
            polymarketConditionId: keccak256("POLYMARKET_TEST_CONDITION"),
            polymarketYesIndex: ProtocolConstants.YES_INDEX_SET,
            polymarketNoIndex: ProtocolConstants.NO_INDEX_SET,
            tradingOpen: uint64(1_800_000_000),
            tradingCutoff: cutoff,
            rulesHash: keccak256("TEST_RULES_V1"),
            metadataHash: keccak256(bytes(metadataUri)),
            priceTickRawX18: uint128(0.01e18),
            baseStep: uint128(0.001e18),
            minNotional: uint128(0.01e18),
            maxOrderQuantity: uint128(1_000e18),
            maxOrderNotional: uint128(1_000_000e18),
            maxWalletOpenNotional: uint128(5_000_000e18),
            maxMarketOpenNotional: uint128(50_000_000e18)
        });
    }
}
