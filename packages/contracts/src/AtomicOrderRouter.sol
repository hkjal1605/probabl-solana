// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAtomicExchange } from "./interfaces/IAtomicExchange.sol";
import { IProtocolAuthority } from "./interfaces/IProtocolAuthority.sol";
import {
    ExecutionGuard,
    Order,
    OrderStateData,
    OrderStatus,
    Payout,
    Side,
    TimeInForce
} from "./types/ProtocolTypes.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAtomicFeeSettlement {
    function feeVault() external view returns (IAtomicFeeVault);
}

interface IAtomicFeeVault {
    function feeRates() external view returns (uint16 makerBps, uint16 takerBps);
}

/// @notice Wallet-authorized, permissionless atomic placement and bounded settlement.
/// @dev No role, transaction relayer, arbitrary external call, or token custody. The caller's
/// transaction authorizes the entire execution plan; an order signature alone cannot relay it.
contract AtomicOrderRouter is ReentrancyGuard {
    error InvalidAddress();
    error NotOrderOwner();
    error InvalidPlan();
    error QuoteExpired();
    error StaleMaker(bytes32 orderHash);
    error StaleBook();
    error StaleFees();

    uint256 public constant MAX_MAKERS = 32;
    uint256 public constant MAX_RELEASES = 32;
    uint256 public constant EXECUTION_VERSION = 2;
    IAtomicExchange public immutable exchange;
    IProtocolAuthority public immutable authority;

    constructor(
        IAtomicExchange exchange_,
        IProtocolAuthority authority_
    ) {
        if (
            address(exchange_) == address(0) || address(exchange_).code.length == 0
                || address(authority_) == address(0)
                || address(exchange_.authority()) != address(authority_)
        ) revert InvalidAddress();
        exchange = exchange_;
        authority = authority_;
    }

    /// @notice Every quoted leg must execute exactly, or the entire placement rolls back.
    /// @param expectedRemaining Maker remainders reviewed by the user, not offchain reservations.
    /// @param deadline Last exclusive execution timestamp, distinct from a GTC resting expiry.
    function placeAndMatch(
        Order calldata taker,
        bytes calldata signature,
        Order[] calldata makers,
        uint128[] calldata quantities,
        uint128[] calldata expectedRemaining,
        uint64 deadline
    ) external nonReentrant returns (bytes32 orderHash) {
        return _place(
            taker, signature, makers, quantities, expectedRemaining, deadline, new bytes32[](0)
        );
    }

    /// @notice First-party quotes additionally bind newly admitted liquidity and fee eligibility.
    /// @dev This is not a proof of best price. The API selects price/FIFO candidates; the guard
    ///      makes a reviewed plan stale if a new order or a fee change could improve that set.
    function placeAndMatchChecked(
        Order calldata taker,
        bytes calldata signature,
        Order[] calldata makers,
        uint128[] calldata quantities,
        uint128[] calldata expectedRemaining,
        uint64 deadline,
        ExecutionGuard calldata guard,
        bytes32[] calldata releaseOrders
    ) external nonReentrant returns (bytes32 orderHash) {
        if (msg.sender != taker.maker) revert NotOrderOwner();
        if (exchange.nextSequence(taker.marketId, taker.branch) != guard.nextSequence) {
            revert StaleBook();
        }
        (uint16 makerBps, uint16 takerBps) =
            IAtomicFeeSettlement(exchange.settlement()).feeVault().feeRates();
        if (makerBps != guard.makerFeeBps || takerBps != guard.takerFeeBps) revert StaleFees();
        if (releaseOrders.length > MAX_RELEASES) revert InvalidPlan();
        return
            _place(taker, signature, makers, quantities, expectedRemaining, deadline, releaseOrders);
    }

    function _place(
        Order calldata taker,
        bytes calldata signature,
        Order[] calldata makers,
        uint128[] calldata quantities,
        uint128[] calldata expectedRemaining,
        uint64 deadline,
        bytes32[] memory releaseOrders
    ) private returns (bytes32 orderHash) {
        if (msg.sender != taker.maker) revert NotOrderOwner();
        if (block.timestamp >= deadline || deadline > taker.expiry) revert QuoteExpired();
        uint256 count = makers.length;
        if (count > MAX_MAKERS || count != quantities.length || count != expectedRemaining.length) {
            revert InvalidPlan();
        }

        // Validate the complete plan before funding or executing any leg. uint256 prevents
        // uint128 sum wraparound even for the maximum number of maximum-sized legs.
        uint256 total;
        bytes32[] memory hashes = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            Order calldata maker = makers[i];
            if (
                maker.tif != TimeInForce.GTC || maker.marketId != taker.marketId
                    || maker.branch != taker.branch || maker.side == taker.side
                    || quantities[i] == 0 || quantities[i] > expectedRemaining[i]
            ) revert InvalidPlan();
            total += quantities[i];
            hashes[i] = exchange.hashOrder(maker);
            for (uint256 j; j < i; ++j) {
                if (hashes[j] == hashes[i]) revert InvalidPlan();
            }
            OrderStateData memory state = exchange.getOrderState(hashes[i]);
            if (state.status != OrderStatus.OPEN || state.remaining != expectedRemaining[i]) {
                revert StaleMaker(hashes[i]);
            }
        }
        if (total > taker.quantity) revert InvalidPlan();

        for (uint256 i; i < releaseOrders.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (releaseOrders[i] == releaseOrders[j]) revert InvalidPlan();
            }
        }
        Payout[] memory payouts = new Payout[](count * 5 + releaseOrders.length + 1);
        uint256 cursor;
        for (uint256 i; i < releaseOrders.length; ++i) {
            payouts[cursor++] = exchange.releaseStaleOrder(releaseOrders[i], taker.marketId);
        }
        orderHash = exchange.openOrder(taker, signature);
        for (uint256 i; i < count; ++i) {
            // Check again after funding. Untrusted recipients are not called until all legs
            // have completed; rejection or nonce invalidation cannot poison a later fill.
            OrderStateData memory state = exchange.getOrderState(hashes[i]);
            if (state.status != OrderStatus.OPEN || state.remaining != expectedRemaining[i]) {
                revert StaleMaker(hashes[i]);
            }
            Payout[5] memory leg = taker.side == Side.BUY
                ? exchange.matchOrders(taker, makers[i], quantities[i])
                : exchange.matchOrders(makers[i], taker, quantities[i]);
            for (uint256 j; j < 5; ++j) {
                payouts[cursor++] = leg[j];
            }
        }
        if (taker.tif == TimeInForce.IOC) payouts[cursor] = exchange.cancelIOCRemainder(orderHash);
        exchange.finalizeAtomicPlacement(orderHash, payouts);
    }
}
