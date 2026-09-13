// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Branch, Order, OrderStateData, Payout } from "../types/ProtocolTypes.sol";
import { IProtocolAuthority } from "./IProtocolAuthority.sol";

interface IAtomicExchange {
    function nextSequence(
        bytes32 marketId,
        Branch branch
    ) external view returns (uint64);
    function settlement() external view returns (address);
    function payoutVault() external view returns (address);
    function authority() external view returns (IProtocolAuthority);
    function hashOrder(
        Order calldata order
    ) external view returns (bytes32);
    function getOrderState(
        bytes32 orderHash
    ) external view returns (OrderStateData memory);
    function openOrder(
        Order calldata order,
        bytes calldata signature
    ) external returns (bytes32);
    function matchOrders(
        Order calldata buyOrder,
        Order calldata sellOrder,
        uint128 quantity
    ) external returns (Payout[5] memory);
    function cancelIOCRemainder(
        bytes32 orderHash
    ) external returns (Payout memory);
    function releaseStaleOrder(
        bytes32 orderHash,
        bytes32 marketId
    ) external returns (Payout memory);
    function finalizeAtomicPlacement(
        bytes32 orderHash,
        Payout[] calldata payouts
    ) external;
}
