// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ManualResolutionController } from "../src/ManualResolutionController.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";
import { OrderValidator } from "../src/OrderValidator.sol";
import { ProtocolConstants } from "../src/libraries/ProtocolConstants.sol";
import {
    Branch,
    FundingKind,
    MarketConfig,
    MarketState,
    Order,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";

contract RejectingClaimRecipient { }

/// @notice Regression tests for the 2026-09-06 audit. I-01 remains a documented cap-scope test.
contract AuditFindingsTest is ProtocolFixture {
    function testRemediationPrepreparedConditionCannotBlockMarketCreation() public {
        string memory uri = "ipfs://conditional-stocks/front-run-target";
        MarketConfig memory config = _config(uri, 500e18, 500e18, 1_000e18);
        bytes32 targetMarketId = registry.computeMarketId(config);
        bytes32 targetQuestionId = keccak256(abi.encode("CONDITIONAL_STOCKS_V2", targetMarketId));

        vm.prank(address(0xBEEF));
        ctf.prepareCondition(address(resolutionController), targetQuestionId, 2);

        assertEq(registry.createMarket(config, uri), targetMarketId, "adopt exact condition");
        assertEq(
            ctf.getOutcomeSlotCount(registry.getMarket(targetMarketId).conditionId), 2, "binary"
        );
        vm.expectRevert(
            abi.encodeWithSelector(MarketRegistry.MarketAlreadyExists.selector, targetMarketId)
        );
        registry.createMarket(config, uri);
    }

    function testRemediationResolutionRejectsDifferentEvidenceHashThanPrepared() public {
        bytes32 preparedHash = keccak256("APPROVED_PACKET");
        bytes32 substitutedHash = keccak256("SUBSTITUTED_PACKET");
        registry.freezeMarket(marketId, keccak256("AUDIT_FREEZE"));
        bytes32 commitment = resolutionController.hashResolution(
            marketId, 1, 0, 1, preparedHash, "ipfs://approved-packet"
        );
        registry.beginResolution(marketId, commitment);

        vm.expectRevert(
            abi.encodeWithSelector(
                ManualResolutionController.InvalidResolutionCommitment.selector, marketId
            )
        );
        resolutionController.resolveMarket(
            marketId, 0, 1, 1, substitutedHash, "ipfs://substituted-packet"
        );

        assertTrue(preparedHash != substitutedHash, "test hashes must differ");
        assertEq(
            uint256(registry.marketState(marketId)),
            uint256(MarketState.AWAITING_RESOLUTION),
            "substituted evidence cannot finalize"
        );
        assertEq(registry.resolutionCommitments(marketId), commitment, "commitment preserved");
        assertEq(ctf.payoutDenominator(market.conditionId), 0, "payout not reported");
    }

    function testFindingFilledExposureCanGrowBeyondMarketOpenNotionalCap() public {
        string memory uri = "ipfs://conditional-stocks/open-notional-only";
        MarketConfig memory config = _config(uri, 200e18, 400e18, 400e18);
        bytes32 cappedMarketId = registry.createMarket(config, uri);
        registry.openMarket(cappedMarketId);

        for (uint64 nonce = 200; nonce < 203; ++nonce) {
            Order memory bid = _order(
                buyer,
                Branch.YES,
                Side.BUY,
                FundingKind.WHOLE_COLLATERAL,
                1e18,
                200e18,
                TimeInForce.GTC,
                nonce,
                keccak256(abi.encode("CAP_BID", nonce))
            );
            Order memory ask = _order(
                seller,
                Branch.YES,
                Side.SELL,
                FundingKind.WHOLE_COLLATERAL,
                1e18,
                200e18,
                TimeInForce.GTC,
                nonce,
                keccak256(abi.encode("CAP_ASK", nonce))
            );
            bid.marketId = cappedMarketId;
            ask.marketId = cappedMarketId;

            _openOrder(bid, _sign(bid, BUYER_KEY));
            _openOrder(ask, _sign(ask, SELLER_KEY));
            _matchOrders(bid, ask, 1e18);
            assertEq(exchange.marketOpenNotional(cappedMarketId), 0, "cap resets after fill");
        }

        assertEq(
            quote.balanceOf(address(ctf)),
            600e18,
            "locked quote collateral exceeds configured 400e18 market cap"
        );
    }

    function testRemediationRejectingRecipientCannotOpenOrder() public {
        RejectingClaimRecipient recipient = new RejectingClaimRecipient();
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            210e18,
            TimeInForce.GTC,
            300,
            keccak256("REJECTING_RECIPIENT_BID")
        );
        bid.recipient = address(recipient);
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            1e18,
            200e18,
            TimeInForce.GTC,
            300,
            keccak256("REJECTING_RECIPIENT_ASK")
        );

        bytes memory signature = _sign(bid, BUYER_KEY);
        uint256 balanceBefore = quote.balanceOf(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderValidator.UnsupportedClaimDestination.selector, address(recipient)
            )
        );
        _openOrder(bid, signature);
        assertEq(quote.balanceOf(buyer), balanceBefore, "no funding pulled");
        assertEq(exchange.marketOpenNotional(marketId), 0, "no phantom open notional");
        _openOrder(ask, _sign(ask, SELLER_KEY));
        vm.expectRevert();
        vm.prank(address(atomicRouter));
        exchange.matchOrders(bid, ask, 1e18);
    }

    function testRemediationRegistryRejectsCapsThatMakeMatchingImpossible() public {
        string memory uri = "ipfs://conditional-stocks/impossible-market-cap";
        MarketConfig memory config = _config(uri, 100e18, 100e18, 100e18);
        config.minNotional = 100e18;
        vm.expectRevert(MarketRegistry.InvalidMarketConfig.selector);
        registry.createMarket(config, uri);
    }

    function testRemediationRegistryRejectsTickAboveEveryPermittedOrderNotional() public {
        string memory uri = "ipfs://conditional-stocks/impossible-price-tick";
        MarketConfig memory config = _config(uri, 100e18, 100e18, 200e18);
        config.priceTickRawX18 = 101e18;
        vm.expectRevert(MarketRegistry.InvalidMarketConfig.selector);
        registry.createMarket(config, uri);
    }

    function _config(
        string memory uri,
        uint128 maxOrderNotional,
        uint128 maxWalletOpenNotional,
        uint128 maxMarketOpenNotional
    ) private view returns (MarketConfig memory) {
        return MarketConfig({
            baseToken: address(stock),
            quoteToken: address(quote),
            polymarketConditionId: keccak256(abi.encode("AUDIT_EVENT", uri)),
            polymarketYesIndex: ProtocolConstants.YES_INDEX_SET,
            polymarketNoIndex: ProtocolConstants.NO_INDEX_SET,
            tradingOpen: uint64(block.timestamp),
            tradingCutoff: cutoff,
            rulesHash: keccak256(abi.encode("AUDIT_RULES", uri)),
            metadataHash: keccak256(bytes(uri)),
            priceTickRawX18: uint128(1e18),
            baseStep: uint128(1e18),
            minNotional: uint128(1e18),
            maxOrderQuantity: uint128(1e18),
            maxOrderNotional: maxOrderNotional,
            maxWalletOpenNotional: maxWalletOpenNotional,
            maxMarketOpenNotional: maxMarketOpenNotional
        });
    }
}
