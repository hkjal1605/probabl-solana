// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ManualResolutionController } from "../src/ManualResolutionController.sol";
import { IConditionalTokens } from "../src/interfaces/IConditionalTokens.sol";
import { MarketState } from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";

contract ResolutionCommitmentTest is ProtocolFixture {
    bytes32 private constant EVIDENCE = keccak256("REVIEWED_PACKET");
    string private constant URI = "ipfs://reviewed-packet";

    function _prepare(
        bytes32 commitment
    ) private {
        registry.freezeMarket(marketId, keccak256("FREEZE"));
        registry.beginResolution(marketId, commitment);
    }

    function _commitment() private view returns (bytes32) {
        return resolutionController.hashResolution(marketId, 1, 0, 1, EVIDENCE, URI);
    }

    function _expectMismatch() private {
        vm.expectRevert(
            abi.encodeWithSelector(
                ManualResolutionController.InvalidResolutionCommitment.selector, marketId
            )
        );
    }

    function _assertPending(
        bytes32 commitment
    ) private view {
        assertEq(registry.resolutionCommitments(marketId), commitment, "pending approval unchanged");
        assertEq(
            uint256(registry.marketState(marketId)),
            uint256(MarketState.AWAITING_RESOLUTION),
            "pending state"
        );
        assertEq(ctf.payoutDenominator(market.conditionId), 0, "no payout");
        assertTrue(!resolutionController.resolved(marketId), "not consumed");
    }

    function testPayoutAndUriCannotChangeEvenWithSameEvidenceHash() public {
        bytes32 commitment = _commitment();
        _prepare(commitment);
        _expectMismatch();
        resolutionController.resolveMarket(marketId, 0, 1, 1, EVIDENCE, URI);
        _expectMismatch();
        resolutionController.resolveMarket(marketId, 1, 1, 2, EVIDENCE, URI);
        _expectMismatch();
        resolutionController.resolveMarket(marketId, 1, 0, 1, EVIDENCE, string.concat(URI, "/"));
        _expectMismatch();
        resolutionController.resolveMarket(marketId, 1, 0, 1, keccak256("OTHER"), URI);
        _assertPending(commitment);
    }

    function testCommitmentIsBoundToChainControllerMarketAndDenominator() public {
        for (uint256 field; field < 4; ++field) {
            bytes32 otherDomain = keccak256(
                abi.encode(
                    "CONDITIONAL_STOCKS_RESOLUTION_V1",
                    block.chainid + (field == 0 ? 1 : 0),
                    field == 1 ? address(0xBEEF) : address(resolutionController),
                    field == 2 ? keccak256("OTHER_MARKET") : marketId,
                    uint256(1),
                    uint256(0),
                    uint256(field == 3 ? 2 : 1),
                    EVIDENCE,
                    keccak256(bytes(URI))
                )
            );
            assertTrue(otherDomain != _commitment(), "domain field must bind");
        }
        bytes32 commitment = _commitment();
        _prepare(commitment);
        // Read through the cheatcode: the optimizer assumes CHAINID is constant within a transaction.
        uint256 originalChain = vm.getChainId();
        vm.chainId(originalChain + 1);
        _expectMismatch();
        resolutionController.resolveMarket(marketId, 1, 0, 1, EVIDENCE, URI);
        _assertPending(commitment);
        vm.chainId(originalChain);
        resolutionController.resolveMarket(marketId, 1, 0, 1, EVIDENCE, URI);
    }

    /// forge-config: default.fuzz.runs = 64
    /// forge-config: ci.fuzz.runs = 256
    function testFuzzExactApprovedVectorFinalizesOnce(
        uint8 outcome
    ) public {
        uint256 choice = uint256(outcome) % 3;
        uint256 yes = choice == 1 ? 0 : 1;
        uint256 no = choice == 0 ? 0 : 1;
        uint256 den = choice == 2 ? 2 : 1;
        _prepare(resolutionController.hashResolution(marketId, yes, no, den, EVIDENCE, URI));
        resolutionController.resolveMarket(marketId, yes, no, den, EVIDENCE, URI);
        assertEq(registry.resolutionCommitments(marketId), bytes32(0), "approval consumed");
        assertEq(ctf.payoutNumerators(market.conditionId, 0), yes, "YES reported");
        assertEq(ctf.payoutNumerators(market.conditionId, 1), no, "NO reported");
        assertEq(ctf.payoutDenominator(market.conditionId), den, "denominator reported");
        assertEq(
            uint256(registry.marketState(marketId)), uint256(MarketState.REDEEMABLE), "final state"
        );
        vm.expectRevert(
            abi.encodeWithSelector(ManualResolutionController.AlreadyResolved.selector, marketId)
        );
        resolutionController.resolveMarket(marketId, yes, no, den, EVIDENCE, URI);
        vm.expectRevert();
        registry.beginResolution(marketId, keccak256("REPLAY"));
    }

    function testCtfReportFailurePreservesApprovalForRetry() public {
        bytes32 commitment = _commitment();
        _prepare(commitment);
        vm.mockCallRevert(
            address(ctf),
            abi.encodeWithSelector(IConditionalTokens.reportPayouts.selector),
            "FAILED_CTF_REPORT"
        );
        vm.expectRevert();
        resolutionController.resolveMarket(marketId, 1, 0, 1, EVIDENCE, URI);
        vm.clearMockedCalls();
        _assertPending(commitment);
        resolutionController.resolveMarket(marketId, 1, 0, 1, EVIDENCE, URI);
        assertTrue(resolutionController.resolved(marketId), "retry succeeds");
    }

    function testNeitherOperationalRoleCanReplaceTheOtherApproval() public {
        authority.grantRole(registry.MARKET_ADMIN_ROLE(), buyer);
        authority.grantRole(resolutionController.RESOLUTION_ADMIN_ROLE(), seller);
        registry.freezeMarket(marketId, keccak256("FREEZE"));
        bytes32 commitment = _commitment();
        vm.prank(seller);
        vm.expectRevert();
        registry.beginResolution(marketId, commitment);
        vm.prank(buyer);
        registry.beginResolution(marketId, commitment);
        vm.prank(buyer);
        vm.expectRevert();
        resolutionController.resolveMarket(marketId, 1, 0, 1, EVIDENCE, URI);
        vm.prank(seller);
        resolutionController.resolveMarket(marketId, 1, 0, 1, EVIDENCE, URI);
    }
}
