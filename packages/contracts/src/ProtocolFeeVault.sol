// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { IConditionalTokens } from "./interfaces/IConditionalTokens.sol";
import { IProtocolAuthority } from "./interfaces/IProtocolAuthority.sol";
import { FeeMath } from "./libraries/FeeMath.sol";
import { ProtocolRoles } from "./libraries/ProtocolRoles.sol";
import { ProtocolAccess } from "./utils/ProtocolAccess.sol";

/// @notice Isolated treasury for received conditional-claim fees; never holds user reservations.
/// @dev No proxy, arbitrary calls, spending approvals, or authority over exchange/CTF collateral.
///      CTF balances are the ledger, avoiding duplicate balances and fee-accrual overflow.
///      Donations of canonical CTF claims are accepted and belong to the treasury too.
contract ProtocolFeeVault is ProtocolAccess, IERC1155Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error InvalidBatch();
    error UnsupportedToken();
    error FeeRateTooHigh();

    event FeeRatesUpdated(
        address indexed admin,
        uint16 oldMakerBps,
        uint16 oldTakerBps,
        uint16 makerBps,
        uint16 takerBps
    );
    event FeesClaimed(address indexed recipient, uint256[] positionIds, uint256[] amounts);
    event FeesRedeemed(
        address indexed recipient,
        address indexed collateralToken,
        bytes32 indexed conditionId,
        uint256 payout
    );

    uint16 public constant MAX_FEE_BPS = FeeMath.MAX_FEE_BPS;
    uint256 public constant MAX_CLAIM_BATCH = 64;
    IConditionalTokens public immutable conditionalTokens;
    // Solidity initializes both packed rates to zero.
    uint16 public makerFeeBps;
    uint16 public takerFeeBps;

    constructor(
        IConditionalTokens conditionalTokens_,
        IProtocolAuthority authority_
    ) ProtocolAccess(authority_) {
        if (
            address(conditionalTokens_) == address(0)
                || address(conditionalTokens_).code.length == 0
        ) {
            revert InvalidAddress();
        }
        conditionalTokens = conditionalTokens_;
    }

    /// @notice Effective immediately for subsequent fills, within each signed order's cap.
    function setFeeRates(
        uint16 makerBps,
        uint16 takerBps
    ) external onlyProtocolRole(ProtocolRoles.DEFAULT_ADMIN_ROLE) {
        if (makerBps > MAX_FEE_BPS || takerBps > MAX_FEE_BPS) revert FeeRateTooHigh();
        emit FeeRatesUpdated(msg.sender, makerFeeBps, takerFeeBps, makerBps, takerBps);
        makerFeeBps = makerBps;
        takerFeeBps = takerBps;
    }

    function feeRates() external view returns (uint16 makerBps, uint16 takerBps) {
        return (makerFeeBps, takerFeeBps);
    }

    /// @notice Withdraw earned claims before or after resolution. Never pulls from another owner.
    function claimFees(
        address recipient,
        uint256[] calldata positionIds,
        uint256[] calldata amounts
    ) external nonReentrant onlyProtocolRole(ProtocolRoles.DEFAULT_ADMIN_ROLE) {
        _requireRecipient(recipient);
        if (
            positionIds.length == 0 || positionIds.length > MAX_CLAIM_BATCH
                || positionIds.length != amounts.length
        ) revert InvalidBatch();
        conditionalTokens.safeBatchTransferFrom(address(this), recipient, positionIds, amounts, "");
        emit FeesClaimed(recipient, positionIds, amounts);
    }

    /// @notice Redeem the vault's resolved binary claims and send the resulting collateral.
    /// @dev This is NOT a redemption fee. Canonical CTF redemption remains completely unchanged.
    function redeemFees(
        IERC20 collateralToken,
        bytes32 conditionId,
        uint256[] calldata indexSets,
        address recipient
    )
        external
        nonReentrant
        onlyProtocolRole(ProtocolRoles.DEFAULT_ADMIN_ROLE)
        returns (uint256 payout)
    {
        _requireRecipient(recipient);
        if (indexSets.length == 0 || indexSets.length > 2) revert InvalidBatch();
        uint256 seen;
        for (uint256 i; i < indexSets.length; ++i) {
            uint256 indexSet = indexSets[i];
            if ((indexSet != 1 && indexSet != 2) || (seen & indexSet) != 0) revert InvalidBatch();
            seen |= indexSet;
        }
        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        conditionalTokens.redeemPositions(collateralToken, bytes32(0), conditionId, indexSets);
        payout = collateralToken.balanceOf(address(this)) - beforeBalance;
        if (payout != 0) collateralToken.safeTransfer(recipient, payout);
        emit FeesRedeemed(recipient, address(collateralToken), conditionId, payout);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IERC1155Receiver).interfaceId;
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        if (msg.sender != address(conditionalTokens)) revert UnsupportedToken();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external view returns (bytes4) {
        if (msg.sender != address(conditionalTokens)) revert UnsupportedToken();
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function _requireRecipient(
        address recipient
    ) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
    }
}
