// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IProtocolAccess } from "../interfaces/IProtocolAccess.sol";
import { IProtocolAuthority } from "../interfaces/IProtocolAuthority.sol";

abstract contract ProtocolAccess is IProtocolAccess {
    error InvalidAuthority();
    error UnauthorizedProtocolRole(bytes32 role, address account);

    IProtocolAuthority public immutable override authority;

    constructor(
        IProtocolAuthority authority_
    ) {
        if (address(authority_) == address(0) || address(authority_).code.length == 0) {
            revert InvalidAuthority();
        }
        authority = authority_;
    }

    modifier onlyProtocolRole(
        bytes32 role
    ) {
        if (!authority.hasRole(role, msg.sender)) {
            revert UnauthorizedProtocolRole(role, msg.sender);
        }
        _;
    }
}
