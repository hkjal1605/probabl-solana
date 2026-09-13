// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IProtocolAuthority } from "./IProtocolAuthority.sol";

interface IProtocolAccess {
    function authority() external view returns (IProtocolAuthority);
}
