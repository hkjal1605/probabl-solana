// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IOrderRecoveryExchange } from "./interfaces/IOrderRecoveryExchange.sol";

/// @notice Permissionless bounded best-effort batches for returning stale order escrow to makers.
contract OrderRecoveryRouter {
    error InvalidAddress();
    error InvalidBatchLength();

    enum ReleaseKind {
        EXPIRED,
        NONCE_INVALIDATED,
        MARKET_CLOSED
    }

    event OrderReleaseAttempt(
        bytes32 indexed orderHash, ReleaseKind indexed kind, bool success, bytes32 failureDataHash
    );

    uint256 public constant MAX_BATCH_LENGTH = 64;
    uint256 public constant MAX_RELEASE_GAS = 300_000;
    uint256 public constant MAX_FAILURE_DATA_BYTES = 256;

    IOrderRecoveryExchange public immutable exchange;

    constructor(
        IOrderRecoveryExchange exchange_
    ) {
        if (address(exchange_) == address(0) || address(exchange_).code.length == 0) {
            revert InvalidAddress();
        }
        exchange = exchange_;
    }

    function releaseExpired(
        bytes32[] calldata orderHashes
    ) external {
        _validateLength(orderHashes.length);
        for (uint256 i; i < orderHashes.length; ++i) {
            _attemptRelease(
                orderHashes[i],
                ReleaseKind.EXPIRED,
                IOrderRecoveryExchange.releaseExpiredOrder.selector
            );
        }
    }

    function releaseInvalidated(
        bytes32[] calldata orderHashes
    ) external {
        _validateLength(orderHashes.length);
        for (uint256 i; i < orderHashes.length; ++i) {
            _attemptRelease(
                orderHashes[i],
                ReleaseKind.NONCE_INVALIDATED,
                IOrderRecoveryExchange.releaseInvalidatedOrder.selector
            );
        }
    }

    function releaseClosedMarkets(
        bytes32[] calldata orderHashes
    ) external {
        _validateLength(orderHashes.length);
        for (uint256 i; i < orderHashes.length; ++i) {
            _attemptRelease(
                orderHashes[i],
                ReleaseKind.MARKET_CLOSED,
                IOrderRecoveryExchange.releaseClosedMarketOrder.selector
            );
        }
    }

    /// @dev Bounds callback gas and return-data copying independently. When failure data is
    ///      truncated the event hashes abi.encode(fullLength, prefix); otherwise it hashes all data.
    ///      A wallet requiring more gas can use the exchange's direct release/cancel entry points.
    function _attemptRelease(
        bytes32 orderHash,
        ReleaseKind kind,
        bytes4 selector
    ) private {
        bytes memory callData = abi.encodeWithSelector(selector, orderHash);
        address target = address(exchange);
        bool success;
        uint256 fullLength;
        bytes memory reason;
        assembly ("memory-safe") {
            success := call(MAX_RELEASE_GAS, target, 0, add(callData, 0x20), mload(callData), 0, 0)
            fullLength := returndatasize()
            let size := fullLength
            if gt(size, MAX_FAILURE_DATA_BYTES) { size := MAX_FAILURE_DATA_BYTES }
            reason := mload(0x40)
            mstore(reason, size)
            returndatacopy(add(reason, 0x20), 0, size)
            mstore(0x40, add(add(reason, 0x20), and(add(size, 0x1f), not(0x1f))))
        }
        bytes32 failureHash = success
            ? bytes32(0)
            : fullLength > MAX_FAILURE_DATA_BYTES
                ? keccak256(abi.encode(fullLength, reason))
                : keccak256(reason);
        emit OrderReleaseAttempt(orderHash, kind, success, failureHash);
    }

    function _validateLength(
        uint256 length
    ) private pure {
        if (length == 0 || length > MAX_BATCH_LENGTH) revert InvalidBatchLength();
    }
}
