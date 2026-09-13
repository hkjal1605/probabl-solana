// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library ProtocolRoles {
    bytes32 internal constant DEFAULT_ADMIN_ROLE = bytes32(0);
    bytes32 internal constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 internal constant RESOLUTION_ADMIN_ROLE = keccak256("RESOLUTION_ADMIN_ROLE");
}
