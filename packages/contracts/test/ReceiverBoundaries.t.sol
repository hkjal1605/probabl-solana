// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IConditionalTokens } from "../src/interfaces/IConditionalTokens.sol";
import { ExpectedCtfReceiver } from "../src/utils/ExpectedCtfReceiver.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

contract ReceiverHarness is ExpectedCtfReceiver {
    constructor(
        IConditionalTokens ctf_
    ) ExpectedCtfReceiver(ctf_) { }

    function armSingle(
        address operator,
        address from,
        uint256 id,
        uint256 value
    ) external {
        _expectSingle(operator, from, id, value);
    }

    function armBatch(
        address operator,
        address from,
        uint256[] memory ids,
        uint256[] memory values
    ) external {
        _expectBatch(operator, from, ids, values);
    }

    function assertReceived() external view {
        _assertExpectedTransferReceived();
    }
}

contract ReceiverBoundariesTest is ProtocolFixture {
    function testSingleCallbackBindsSenderOperatorOwnerIdAmountAndCannotReplay() public {
        ReceiverHarness receiver = new ReceiverHarness(ctf);
        assertTrue(receiver.supportsInterface(0x01ffc9a7), "ERC165 supported");
        assertTrue(
            receiver.supportsInterface(type(IERC1155Receiver).interfaceId), "receiver supported"
        );
        assertTrue(!receiver.supportsInterface(0xffffffff), "invalid interface rejected");
        receiver.armSingle(buyer, seller, 1, 5);
        vm.expectRevert(ExpectedCtfReceiver.ConditionalTokenTransferNotReceived.selector);
        receiver.assertReceived();
        vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
        receiver.armSingle(buyer, seller, 1, 5);
        for (uint256 field; field < 5; ++field) {
            vm.prank(field == 0 ? buyer : address(ctf));
            vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
            receiver.onERC1155Received(
                field == 1 ? seller : buyer,
                field == 2 ? buyer : seller,
                field == 3 ? 2 : 1,
                field == 4 ? 6 : 5,
                ""
            );
        }
        vm.prank(address(ctf));
        receiver.onERC1155Received(buyer, seller, 1, 5, "");
        receiver.assertReceived();
        vm.prank(address(ctf));
        vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
        receiver.onERC1155Received(buyer, seller, 1, 5, "");
    }

    function testBatchCallbackBindsArraysAndRejectsOverlappingExpectations() public {
        ReceiverHarness receiver = new ReceiverHarness(ctf);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        amounts[0] = 5;
        amounts[1] = 5;
        receiver.armBatch(buyer, seller, ids, amounts);
        vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
        receiver.armBatch(buyer, seller, ids, amounts);
        amounts[1] = 6;
        vm.prank(address(ctf));
        vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
        receiver.onERC1155BatchReceived(buyer, seller, ids, amounts, "");
        amounts[1] = 5;
        vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
        receiver.onERC1155BatchReceived(buyer, seller, ids, amounts, "");
        vm.prank(address(ctf));
        receiver.onERC1155BatchReceived(buyer, seller, ids, amounts, "");
        receiver.assertReceived();
        vm.prank(address(ctf));
        vm.expectRevert(ExpectedCtfReceiver.UnexpectedConditionalTokenTransfer.selector);
        receiver.onERC1155BatchReceived(buyer, seller, ids, amounts, "");
    }
}
