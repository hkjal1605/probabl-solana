// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IOrderRecoveryExchange {
    function releaseExpiredOrder(
        bytes32 orderHash
    ) external;
    function releaseInvalidatedOrder(
        bytes32 orderHash
    ) external;
    function releaseClosedMarketOrder(
        bytes32 orderHash
    ) external;
}
