// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ProtocolConstants } from "../src/libraries/ProtocolConstants.sol";
import { Branch, FundingKind, Order, Side, TimeInForce } from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";

/// @notice Full trade-to-manual-resolution-to-redemption acceptance paths for milestone 11.
contract Milestone11LifecycleE2ETest is ProtocolFixture {
    uint128 private constant QUANTITY = 2e18;
    uint128 private constant PRICE = 200e18;

    function testTradeToYesResolutionAndRedemption() public {
        _trade(Branch.YES, 100);
        _resolve(1, 0, 1);

        uint256 buyerStockBefore = stock.balanceOf(buyer);
        uint256 sellerQuoteBefore = quote.balanceOf(seller);
        _redeem(buyer, IERC20(stock), ProtocolConstants.YES_INDEX_SET, QUANTITY);
        _redeem(seller, IERC20(quote), ProtocolConstants.YES_INDEX_SET, 400e18);

        assertEq(stock.balanceOf(buyer), buyerStockBefore + QUANTITY, "YES stock redeemed");
        assertEq(quote.balanceOf(seller), sellerQuoteBefore + 400e18, "YES quote redeemed");
    }

    function testTradeToNoResolutionAndRedemption() public {
        _trade(Branch.NO, 101);
        _resolve(0, 1, 1);

        uint256 buyerStockBefore = stock.balanceOf(buyer);
        uint256 sellerQuoteBefore = quote.balanceOf(seller);
        _redeem(buyer, IERC20(stock), ProtocolConstants.NO_INDEX_SET, QUANTITY);
        _redeem(seller, IERC20(quote), ProtocolConstants.NO_INDEX_SET, 400e18);

        assertEq(stock.balanceOf(buyer), buyerStockBefore + QUANTITY, "NO stock redeemed");
        assertEq(quote.balanceOf(seller), sellerQuoteBefore + 400e18, "NO quote redeemed");
    }

    function testTradeToInvalidResolutionAndAllClaimsRedemption() public {
        _trade(Branch.YES, 102);
        _resolve(1, 1, 2);

        uint256 buyerStockBefore = stock.balanceOf(buyer);
        uint256 buyerQuoteBefore = quote.balanceOf(buyer);
        uint256 sellerStockBefore = stock.balanceOf(seller);
        uint256 sellerQuoteBefore = quote.balanceOf(seller);
        _redeem(buyer, IERC20(stock), ProtocolConstants.YES_INDEX_SET, QUANTITY);
        _redeem(buyer, IERC20(quote), ProtocolConstants.NO_INDEX_SET, 400e18);
        _redeem(seller, IERC20(stock), ProtocolConstants.NO_INDEX_SET, QUANTITY);
        _redeem(seller, IERC20(quote), ProtocolConstants.YES_INDEX_SET, 400e18);

        assertEq(stock.balanceOf(buyer), buyerStockBefore + 1e18, "invalid buyer stock half");
        assertEq(quote.balanceOf(buyer), buyerQuoteBefore + 200e18, "invalid buyer quote half");
        assertEq(stock.balanceOf(seller), sellerStockBefore + 1e18, "invalid seller stock half");
        assertEq(quote.balanceOf(seller), sellerQuoteBefore + 200e18, "invalid seller quote half");
    }

    function _trade(
        Branch branch,
        uint64 nonce
    ) private {
        Order memory bid = _order(
            buyer,
            branch,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            PRICE,
            TimeInForce.GTC,
            nonce,
            keccak256(abi.encode("M11_BID", nonce))
        );
        Order memory ask = _order(
            seller,
            branch,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            QUANTITY,
            PRICE,
            TimeInForce.GTC,
            nonce,
            keccak256(abi.encode("M11_ASK", nonce))
        );
        _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        _matchOrders(bid, ask, QUANTITY);
    }

    function _resolve(
        uint256 yes,
        uint256 no,
        uint256 denominator
    ) private {
        registry.freezeMarket(marketId, keccak256("MILESTONE_11_E2E_FREEZE"));
        registry.beginResolution(
            marketId,
            resolutionController.hashResolution(
                marketId,
                yes,
                no,
                denominator,
                keccak256("MILESTONE_11_REVIEWED_EVIDENCE"),
                "ipfs://milestone-11-reviewed-evidence"
            )
        );
        resolutionController.resolveMarket(
            marketId,
            yes,
            no,
            denominator,
            keccak256("MILESTONE_11_REVIEWED_EVIDENCE"),
            "ipfs://milestone-11-reviewed-evidence"
        );
    }

    function _redeem(
        address account,
        IERC20 collateral,
        uint256 indexSet,
        uint256 amount
    ) private {
        uint256[] memory indexSets = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indexSets[0] = indexSet;
        amounts[0] = amount;
        vm.prank(account);
        positionRouter.redeemForUser(collateral, market.conditionId, indexSets, amounts, account);
    }
}
