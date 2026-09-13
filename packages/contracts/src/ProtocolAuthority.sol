// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import { ProtocolRoles } from "./libraries/ProtocolRoles.sol";

/// @notice Single auditable role registry for the non-upgradeable v1 protocol contracts.
/// @dev The default administrator transfer is subject to a mandatory delay. Operational
///      roles can authorize only the functions that query their exact role identifier.
contract ProtocolAuthority is AccessControlDefaultAdminRules {
    error InvalidAddress();

    uint48 public constant DEFAULT_ADMIN_TRANSFER_DELAY = 2 days;

    constructor(
        address initialAdmin,
        address initialMarketAdmin,
        address initialGuardian,
        address initialResolutionAdmin
    ) AccessControlDefaultAdminRules(DEFAULT_ADMIN_TRANSFER_DELAY, initialAdmin) {
        if (
            initialMarketAdmin == address(0) || initialGuardian == address(0)
                || initialResolutionAdmin == address(0)
        ) revert InvalidAddress();

        _grantRole(ProtocolRoles.MARKET_ADMIN_ROLE, initialMarketAdmin);
        _grantRole(ProtocolRoles.GUARDIAN_ROLE, initialGuardian);
        _grantRole(ProtocolRoles.RESOLUTION_ADMIN_ROLE, initialResolutionAdmin);
    }
}
