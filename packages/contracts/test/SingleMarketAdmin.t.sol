// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MarketConfig, MarketState} from "../src/types/ProtocolTypes.sol";
import {ProtocolFixture} from "./ProtocolFixture.sol";

/// @notice The existing deployment supports one operator through role grants, without changing code.
contract SingleMarketAdminTest is ProtocolFixture {
    function testSingleAdminCreatesOpensFreezesAndResolvesAfterRoleGrant() public {
        bytes32 resolutionRole = resolutionController.RESOLUTION_ADMIN_ROLE();
        authority.grantRole(registry.MARKET_ADMIN_ROLE(), buyer);
        MarketConfig memory config = MarketConfig({
            baseToken: market.baseToken,
            quoteToken: market.quoteToken,
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesIndex: market.polymarketYesIndex,
            polymarketNoIndex: market.polymarketNoIndex,
            tradingOpen: market.tradingOpen,
            tradingCutoff: market.tradingCutoff,
            rulesHash: market.rulesHash,
            metadataHash: market.metadataHash,
            priceTickRawX18: market.priceTickRawX18,
            baseStep: market.baseStep,
            minNotional: market.minNotional,
            maxOrderQuantity: market.maxOrderQuantity,
            maxOrderNotional: market.maxOrderNotional,
            maxWalletOpenNotional: market.maxWalletOpenNotional,
            maxMarketOpenNotional: market.maxMarketOpenNotional
        });
        config.polymarketConditionId = keccak256("SINGLE_ADMIN_MARKET");
        vm.prank(buyer);
        bytes32 created = registry.createMarket(config, "ipfs://conditional-stocks/test-market");
        vm.prank(buyer);
        registry.openMarket(created);
        vm.prank(buyer);
        registry.freezeMarket(created, keccak256("EVENT_CLOSED"));
        bytes32 evidence = keccak256("ADMIN_REVIEWED_EVIDENCE");
        string memory uri = "ipfs://single-admin-evidence";
        bytes32 commitment = resolutionController.hashResolution(created, 1, 0, 1, evidence, uri);
        vm.prank(buyer);
        registry.beginResolution(created, commitment);

        // MARKET_ADMIN alone cannot finalize or grant itself the resolution role.
        vm.prank(buyer);
        vm.expectRevert();
        resolutionController.resolveMarket(created, 1, 0, 1, evidence, uri);
        vm.prank(buyer);
        vm.expectRevert();
        authority.grantRole(resolutionRole, buyer);
        assertEq(registry.resolutionCommitments(created), commitment, "failed attempt preserves commitment");

        authority.grantRole(resolutionRole, buyer);
        vm.prank(buyer);
        resolutionController.resolveMarket(created, 1, 0, 1, evidence, uri);
        assertEq(
            uint256(registry.marketState(created)), uint256(MarketState.REDEEMABLE), "single wallet completed lifecycle"
        );
        assertEq(ctf.payoutNumerators(registry.getMarket(created).conditionId, 0), 1, "canonical YES payout");
        assertEq(registry.resolutionCommitments(created), bytes32(0), "commitment consumed");
        assertTrue(!authority.hasRole(bytes32(0), buyer), "no governance privileges granted");
    }

    function testRevokingResolutionRoleBlocksFinalizationWithoutLosingCommitment() public {
        authority.grantRole(registry.MARKET_ADMIN_ROLE(), buyer);
        authority.grantRole(resolutionController.RESOLUTION_ADMIN_ROLE(), buyer);
        bytes32 evidence = keccak256("REVIEWED_NO");
        string memory uri = "ipfs://no-evidence";
        bytes32 commitment = resolutionController.hashResolution(marketId, 0, 1, 1, evidence, uri);
        vm.startPrank(buyer);
        registry.freezeMarket(marketId, keccak256("CUTOFF"));
        registry.beginResolution(marketId, commitment);
        vm.stopPrank();
        authority.revokeRole(resolutionController.RESOLUTION_ADMIN_ROLE(), buyer);
        vm.prank(buyer);
        vm.expectRevert();
        resolutionController.resolveMarket(marketId, 0, 1, 1, evidence, uri);
        assertEq(registry.resolutionCommitments(marketId), commitment, "commitment unchanged");
        assertEq(ctf.payoutDenominator(market.conditionId), 0, "no unapproved payout");
    }
}
