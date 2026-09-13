// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IConditionalTokens } from "./interfaces/IConditionalTokens.sol";
import { ProtocolConstants } from "./libraries/ProtocolConstants.sol";
import { ExpectedCtfReceiver } from "./utils/ExpectedCtfReceiver.sol";

/// @notice Noncustodial exact-amount helpers for CTF merge and redemption.
/// @dev Users may always bypass this helper and call Conditional Tokens directly.
contract PositionRouter is ExpectedCtfReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidAmount();
    error InvalidRecipient();
    error InvalidPositionSet();
    error ResidualBalance();

    event PositionsMerged(
        address indexed account,
        address indexed recipient,
        address indexed collateralToken,
        bytes32 conditionId,
        uint256 amount
    );
    event PositionsRedeemed(
        address indexed account,
        address indexed recipient,
        address indexed collateralToken,
        bytes32 conditionId,
        uint256 payout
    );

    constructor(
        IConditionalTokens conditionalTokens_
    ) ExpectedCtfReceiver(conditionalTokens_) { }

    function mergeForUser(
        IERC20 collateralToken,
        bytes32 conditionId,
        uint256 amount,
        address recipient
    ) external nonReentrant returns (uint256 collateralReturned) {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        (uint256[] memory indexSets, uint256[] memory positionIds) =
            _binaryPositionIds(collateralToken, conditionId);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amount;
        amounts[1] = amount;
        _requireNoPositionBalance(positionIds);

        _expectBatch(address(this), msg.sender, positionIds, amounts);
        conditionalTokens.safeBatchTransferFrom(msg.sender, address(this), positionIds, amounts, "");
        _assertExpectedTransferReceived();

        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        conditionalTokens.mergePositions(
            collateralToken, ProtocolConstants.PARENT_COLLECTION_ID, conditionId, indexSets, amount
        );
        collateralReturned = collateralToken.balanceOf(address(this)) - beforeBalance;
        if (collateralReturned != amount) revert ResidualBalance();
        collateralToken.safeTransfer(recipient, collateralReturned);

        _requireNoPositionBalance(positionIds);
        emit PositionsMerged(
            msg.sender, recipient, address(collateralToken), conditionId, collateralReturned
        );
    }

    function redeemForUser(
        IERC20 collateralToken,
        bytes32 conditionId,
        uint256[] calldata indexSets,
        uint256[] calldata amounts,
        address recipient
    ) external nonReentrant returns (uint256 payout) {
        uint256 length = indexSets.length;
        if (length == 0 || length > 2 || length != amounts.length) revert InvalidPositionSet();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        uint256[] memory positionIds = new uint256[](length);
        uint256[] memory copiedIndexSets = new uint256[](length);
        uint256[] memory copiedAmounts = new uint256[](length);
        uint256 seen;
        for (uint256 i; i < length; ++i) {
            uint256 indexSet = indexSets[i];
            if (
                (indexSet != ProtocolConstants.YES_INDEX_SET
                        && indexSet != ProtocolConstants.NO_INDEX_SET) || amounts[i] == 0
                    || (seen & indexSet) != 0
            ) revert InvalidPositionSet();
            seen |= indexSet;
            copiedIndexSets[i] = indexSet;
            copiedAmounts[i] = amounts[i];
            positionIds[i] = _positionId(collateralToken, conditionId, indexSet);
        }
        _requireNoPositionBalance(positionIds);

        _expectBatch(address(this), msg.sender, positionIds, copiedAmounts);
        conditionalTokens.safeBatchTransferFrom(
            msg.sender, address(this), positionIds, copiedAmounts, ""
        );
        _assertExpectedTransferReceived();

        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        conditionalTokens.redeemPositions(
            collateralToken, ProtocolConstants.PARENT_COLLECTION_ID, conditionId, copiedIndexSets
        );
        payout = collateralToken.balanceOf(address(this)) - beforeBalance;
        if (payout != 0) collateralToken.safeTransfer(recipient, payout);

        _requireNoPositionBalance(positionIds);
        emit PositionsRedeemed(msg.sender, recipient, address(collateralToken), conditionId, payout);
    }

    function _binaryPositionIds(
        IERC20 collateralToken,
        bytes32 conditionId
    ) private view returns (uint256[] memory indexSets, uint256[] memory positionIds) {
        indexSets = new uint256[](2);
        indexSets[0] = ProtocolConstants.YES_INDEX_SET;
        indexSets[1] = ProtocolConstants.NO_INDEX_SET;
        positionIds = new uint256[](2);
        positionIds[0] = _positionId(collateralToken, conditionId, indexSets[0]);
        positionIds[1] = _positionId(collateralToken, conditionId, indexSets[1]);
    }

    function _positionId(
        IERC20 collateralToken,
        bytes32 conditionId,
        uint256 indexSet
    ) private view returns (uint256) {
        bytes32 collectionId = conditionalTokens.getCollectionId(
            ProtocolConstants.PARENT_COLLECTION_ID, conditionId, indexSet
        );
        return conditionalTokens.getPositionId(collateralToken, collectionId);
    }

    function _requireNoPositionBalance(
        uint256[] memory positionIds
    ) private view {
        uint256 length = positionIds.length;
        for (uint256 i; i < length; ++i) {
            if (conditionalTokens.balanceOf(address(this), positionIds[i]) != 0) {
                revert ResidualBalance();
            }
        }
    }
}
