// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Order } from "../types/ProtocolTypes.sol";

interface IOrderValidator {
    function exchange() external view returns (address);
    function hashOrder(
        Order calldata order
    ) external view returns (bytes32);
    function validate(
        Order calldata order,
        bytes calldata signature
    ) external view returns (bytes32 orderHash);
}
