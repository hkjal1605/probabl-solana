// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library ProtocolConstants {
    uint32 internal constant PROTOCOL_VERSION = 2;
    uint256 internal constant POLYGON_CHAIN_ID = 137;
    uint256 internal constant OUTCOME_SLOT_COUNT = 2;
    uint256 internal constant YES_INDEX_SET = 1;
    uint256 internal constant NO_INDEX_SET = 2;
    uint256 internal constant WAD = 1e18;
    bytes32 internal constant PARENT_COLLECTION_ID = bytes32(0);
}
