// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IConditionalTokens } from "./interfaces/IConditionalTokens.sol";
import { Payout } from "./types/ProtocolTypes.sol";
import { ExpectedCtfReceiver } from "./utils/ExpectedCtfReceiver.sol";

interface IPayoutExchange {
    function settlement() external view returns (address);
}

/// @notice Isolates failed payouts without giving an administrator custody of user credits.
/// @dev The exchange creates this immutable vault. Assets are staged before recipient callbacks;
///      successful deliveries leave in the same transaction, only failures become credits.
///      There is no sweep, upgrade, delegated withdrawal, or arbitrary-call function.
contract PayoutVault is ExpectedCtfReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidPayout();
    error UnsupportedTransfer();
    error InsufficientBacking();
    error InsufficientCredit();
    error InsufficientDeliveryGas();

    event PayoutDeferred(
        address indexed beneficiary, address indexed asset, uint256 indexed tokenId, uint256 amount
    );
    event PayoutClaimed(
        address indexed beneficiary,
        address indexed asset,
        uint256 indexed tokenId,
        address recipient,
        uint256 amount
    );

    uint256 public constant DELIVERY_GAS = 100_000;
    // 32 fills * 5 payouts + 32 stale releases + one IOC refund.
    uint256 public constant MAX_PAYOUTS = 193;
    address public immutable exchange;
    mapping(
        address beneficiary => mapping(address asset => mapping(uint256 tokenId => uint256 amount))
    ) public claimable;
    mapping(address asset => mapping(uint256 tokenId => uint256 amount)) public totalClaimable;

    constructor(
        IConditionalTokens conditionalTokens_
    ) ExpectedCtfReceiver(conditionalTokens_) {
        exchange = msg.sender;
    }

    modifier onlyProvider() {
        if (msg.sender != exchange && msg.sender != IPayoutExchange(exchange).settlement()) {
            revert Unauthorized();
        }
        _;
    }

    function fundClaim(
        uint256 tokenId,
        uint256 amount
    ) external nonReentrant onlyProvider {
        if (amount == 0) revert InvalidPayout();
        _expectSingle(address(this), msg.sender, tokenId, amount);
        conditionalTokens.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        _assertExpectedTransferReceived();
    }

    function fundWhole(
        address asset,
        uint256 amount
    ) external nonReentrant onlyProvider {
        if (asset == address(conditionalTokens) || amount == 0) revert InvalidPayout();
        IERC20 token = IERC20(asset);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTransfer();
    }

    /// @dev Only the fixed exchange can spend unallocated assets. Already credited balances
    ///      are excluded from free backing and cannot fund another delivery or another credit.
    function deliver(
        Payout[] calldata payouts
    ) external nonReentrant {
        if (msg.sender != exchange) revert Unauthorized();
        if (payouts.length > MAX_PAYOUTS) revert InvalidPayout();
        for (uint256 i; i < payouts.length; ++i) {
            Payout calldata payout = payouts[i];
            if (payout.amount == 0) continue;
            if (
                payout.beneficiary == address(0)
                    || (payout.asset != address(conditionalTokens) && payout.tokenId != 0)
            ) revert InvalidPayout();
            uint256 liabilities = totalClaimable[payout.asset][payout.tokenId];
            uint256 balance = _balance(payout.asset, payout.tokenId);
            if (balance < liabilities || balance - liabilities < payout.amount) {
                revert InsufficientBacking();
            }
            bytes memory data = abi.encodeCall(this.attemptDelivery, (payout));
            // Guarantee the full stipend despite EIP-150, with room for two cold credit writes
            // and the event. An under-gassed transaction must revert, not manufacture a failure.
            if (gasleft() < DELIVERY_GAS + DELIVERY_GAS / 63 + 80_000) {
                revert InsufficientDeliveryGas();
            }
            bool delivered;
            uint256 stipend = DELIVERY_GAS;
            // Never copy recipient-controlled return/revert data into the outer execution.
            assembly ("memory-safe") {
                delivered := call(stipend, address(), 0, add(data, 32), mload(data), 0, 0)
            }
            if (!delivered) {
                claimable[payout.beneficiary][payout.asset][payout.tokenId] += payout.amount;
                totalClaimable[payout.asset][payout.tokenId] = liabilities + payout.amount;
                emit PayoutDeferred(payout.beneficiary, payout.asset, payout.tokenId, payout.amount);
            }
        }
    }

    /// @dev A separate call frame rolls back even a token that moves funds then returns false.
    ///      Deliberately no nonReentrant: this self-call runs inside deliver's guard.
    function attemptDelivery(
        Payout calldata payout
    ) external {
        if (msg.sender != address(this)) revert Unauthorized();
        _transfer(payout.asset, payout.tokenId, payout.amount, payout.beneficiary);
    }

    /// @notice Only the credited beneficiary may choose where their exact asset is withdrawn.
    /// @dev No stipend on explicit withdrawal; a costly receiver can use sufficient gas or an
    ///      alternate destination. Rejection restores the credit atomically.
    function withdraw(
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external nonReentrant {
        if (amount == 0 || recipient == address(0) || recipient == address(this)) {
            revert InvalidPayout();
        }
        uint256 credit = claimable[msg.sender][asset][tokenId];
        if (amount > credit) revert InsufficientCredit();
        claimable[msg.sender][asset][tokenId] = credit - amount;
        totalClaimable[asset][tokenId] -= amount;
        _transfer(asset, tokenId, amount, recipient);
        emit PayoutClaimed(msg.sender, asset, tokenId, recipient, amount);
    }

    function _balance(
        address asset,
        uint256 tokenId
    ) private view returns (uint256) {
        if (asset == address(conditionalTokens)) {
            return conditionalTokens.balanceOf(address(this), tokenId);
        }
        return IERC20(asset).balanceOf(address(this));
    }

    function _transfer(
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) private {
        uint256 beforeBalance = _balance(asset, tokenId);
        if (asset == address(conditionalTokens)) {
            conditionalTokens.safeTransferFrom(address(this), recipient, tokenId, amount, "");
        } else {
            IERC20 token = IERC20(asset);
            uint256 recipientBefore = token.balanceOf(recipient);
            token.safeTransfer(recipient, amount);
            if (token.balanceOf(recipient) - recipientBefore != amount) {
                revert UnsupportedTransfer();
            }
        }
        if (beforeBalance - _balance(asset, tokenId) != amount) revert UnsupportedTransfer();
    }
}
