// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IProtocolAuthority } from "./IProtocolAuthority.sol";

interface IAtomicOrderRouter {
    function authority() external view returns (IProtocolAuthority);
    function exchange() external view returns (address);
}
