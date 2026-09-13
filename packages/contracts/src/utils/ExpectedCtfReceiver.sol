// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { IConditionalTokens } from "../interfaces/IConditionalTokens.sol";

/// @dev Rejects unsolicited CTF claims and accepts only a precisely precommitted callback.
abstract contract ExpectedCtfReceiver is IERC1155Receiver {
    error UnexpectedConditionalTokenTransfer();
    error ConditionalTokenTransferNotReceived();

    IConditionalTokens public immutable conditionalTokens;

    bytes32 private _expectedTransferHash;

    constructor(
        IConditionalTokens conditionalTokens_
    ) {
        if (
            address(conditionalTokens_) == address(0)
                || address(conditionalTokens_).code.length == 0
        ) revert UnexpectedConditionalTokenTransfer();
        conditionalTokens = conditionalTokens_;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata
    ) external returns (bytes4) {
        bytes32 actual = keccak256(abi.encode(false, operator, from, id, value));
        if (msg.sender != address(conditionalTokens) || actual != _expectedTransferHash) {
            revert UnexpectedConditionalTokenTransfer();
        }
        delete _expectedTransferHash;
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata
    ) external returns (bytes4) {
        bytes32 actual = keccak256(abi.encode(true, operator, from, ids, values));
        if (msg.sender != address(conditionalTokens) || actual != _expectedTransferHash) {
            revert UnexpectedConditionalTokenTransfer();
        }
        delete _expectedTransferHash;
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function _expectSingle(
        address operator,
        address from,
        uint256 id,
        uint256 value
    ) internal {
        if (_expectedTransferHash != bytes32(0)) revert UnexpectedConditionalTokenTransfer();
        _expectedTransferHash = keccak256(abi.encode(false, operator, from, id, value));
    }

    function _expectBatch(
        address operator,
        address from,
        uint256[] memory ids,
        uint256[] memory values
    ) internal {
        if (_expectedTransferHash != bytes32(0)) revert UnexpectedConditionalTokenTransfer();
        _expectedTransferHash = keccak256(abi.encode(true, operator, from, ids, values));
    }

    function _assertExpectedTransferReceived() internal view {
        if (_expectedTransferHash != bytes32(0)) revert ConditionalTokenTransferNotReceived();
    }
}
