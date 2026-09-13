// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IConditionalTokens } from "./interfaces/IConditionalTokens.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { IProtocolAuthority } from "./interfaces/IProtocolAuthority.sol";
import { ProtocolRoles } from "./libraries/ProtocolRoles.sol";
import { Market, MarketState } from "./types/ProtocolTypes.sol";
import { ProtocolAccess } from "./utils/ProtocolAccess.sol";

/// @notice Human-triggered, role-gated local oracle for the three allowed binary payouts.
/// @dev This contract performs no API lookup, Polygon verification, or cross-chain messaging.
contract ManualResolutionController is ProtocolAccess, ReentrancyGuard {
    error AlreadyResolved(bytes32 marketId);
    error EmptyEvidence();
    error InvalidAddress();
    error InvalidPayoutVector();
    error InvalidResolutionState(bytes32 marketId, MarketState state);
    error InvalidResolutionCommitment(bytes32 marketId);

    event ResolutionFinalized(
        bytes32 indexed marketId,
        bytes32 indexed conditionId,
        address indexed admin,
        uint256 yesPayout,
        uint256 noPayout,
        uint256 payoutDenominator,
        bytes32 evidenceHash,
        string evidenceUri,
        uint256 finalizedAt
    );

    bytes32 public constant RESOLUTION_ADMIN_ROLE = ProtocolRoles.RESOLUTION_ADMIN_ROLE;
    uint32 public constant CONTROLLER_VERSION = 1;
    uint256 public constant MAX_EVIDENCE_URI_LENGTH = 512;

    IConditionalTokens public immutable ctf;
    IMarketRegistry public immutable registry;

    mapping(bytes32 marketId => bool resolved) public resolved;

    constructor(
        IConditionalTokens ctf_,
        IMarketRegistry registry_,
        IProtocolAuthority authority_
    ) ProtocolAccess(authority_) {
        if (
            address(ctf_) == address(0) || address(registry_) == address(0)
                || address(ctf_).code.length == 0 || address(registry_).code.length == 0
        ) revert InvalidAddress();
        if (
            address(registry_.ctf()) != address(ctf_)
                || address(registry_.authority()) != address(authority_)
        ) revert InvalidAddress();
        ctf = ctf_;
        registry = registry_;
    }

    function resolveMarket(
        bytes32 marketId,
        uint256 yesPayout,
        uint256 noPayout,
        uint256 payoutDenominator,
        bytes32 evidenceHash,
        string calldata evidenceUri
    ) external nonReentrant onlyProtocolRole(RESOLUTION_ADMIN_ROLE) {
        if (resolved[marketId]) revert AlreadyResolved(marketId);
        if (
            evidenceHash == bytes32(0) || bytes(evidenceUri).length == 0
                || bytes(evidenceUri).length > MAX_EVIDENCE_URI_LENGTH
        ) revert EmptyEvidence();
        if (!_validPayout(yesPayout, noPayout, payoutDenominator)) {
            revert InvalidPayoutVector();
        }

        Market memory market = registry.getMarket(marketId);
        if (market.state != MarketState.AWAITING_RESOLUTION) {
            revert InvalidResolutionState(marketId, market.state);
        }
        if (
            registry.resolutionCommitments(marketId)
                != hashResolution(
                    marketId, yesPayout, noPayout, payoutDenominator, evidenceHash, evidenceUri
                )
        ) revert InvalidResolutionCommitment(marketId);

        resolved[marketId] = true;
        uint256[] memory payouts = new uint256[](2);
        payouts[0] = yesPayout;
        payouts[1] = noPayout;
        ctf.reportPayouts(market.localQuestionId, payouts);
        registry.markResolved(marketId);
        registry.markRedeemable(marketId);

        emit ResolutionFinalized(
            marketId,
            market.conditionId,
            msg.sender,
            yesPayout,
            noPayout,
            payoutDenominator,
            evidenceHash,
            evidenceUri,
            block.timestamp
        );
    }

    /// @notice Exact commitment the market administrator must prepare before finalization.
    function hashResolution(
        bytes32 marketId,
        uint256 yesPayout,
        uint256 noPayout,
        uint256 payoutDenominator,
        bytes32 evidenceHash,
        string calldata evidenceUri
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "CONDITIONAL_STOCKS_RESOLUTION_V1",
                block.chainid,
                address(this),
                marketId,
                yesPayout,
                noPayout,
                payoutDenominator,
                evidenceHash,
                keccak256(bytes(evidenceUri))
            )
        );
    }

    function _validPayout(
        uint256 yesPayout,
        uint256 noPayout,
        uint256 denominator
    ) private pure returns (bool) {
        return (yesPayout == 1 && noPayout == 0 && denominator == 1)
            || (yesPayout == 0 && noPayout == 1 && denominator == 1)
            || (yesPayout == 1 && noPayout == 1 && denominator == 2);
    }
}
