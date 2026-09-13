// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function getChainId() external view returns (uint256);
    function chainId(
        uint256 newChainId
    ) external;
    function mockCall(
        address callee,
        bytes calldata data,
        bytes calldata returnData
    ) external;
    function mockCallRevert(
        address callee,
        bytes calldata data,
        bytes calldata revertData
    ) external;
    function clearMockedCalls() external;
    function addr(
        uint256 privateKey
    ) external returns (address);
    function assume(
        bool condition
    ) external;
    function expectRevert() external;
    function expectRevert(
        bytes4 revertData
    ) external;
    function expectRevert(
        bytes calldata revertData
    ) external;
    function etch(
        address target,
        bytes calldata newRuntimeBytecode
    ) external;
    function parseJsonAddress(
        string calldata json,
        string calldata key
    ) external pure returns (address);
    function parseJsonBytes(
        string calldata json,
        string calldata key
    ) external pure returns (bytes memory);
    function parseJsonBytes32(
        string calldata json,
        string calldata key
    ) external pure returns (bytes32);
    function parseJsonUint(
        string calldata json,
        string calldata key
    ) external pure returns (uint256);
    function prank(
        address msgSender
    ) external;
    function readFile(
        string calldata path
    ) external view returns (string memory);
    function sign(
        uint256 privateKey,
        bytes32 digest
    ) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(
        address msgSender
    ) external;
    function stopPrank() external;
    function warp(
        uint256 newTimestamp
    ) external;
}

abstract contract TestBase {
    error AssertionFailed(string message);

    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(
        uint256 actual,
        uint256 expected,
        string memory message
    ) internal pure {
        if (actual != expected) revert AssertionFailed(message);
    }

    function assertEq(
        bytes32 actual,
        bytes32 expected,
        string memory message
    ) internal pure {
        if (actual != expected) revert AssertionFailed(message);
    }

    function assertEq(
        address actual,
        address expected,
        string memory message
    ) internal pure {
        if (actual != expected) revert AssertionFailed(message);
    }

    function assertTrue(
        bool condition,
        string memory message
    ) internal pure {
        if (!condition) revert AssertionFailed(message);
    }
}
