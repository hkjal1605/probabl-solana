// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockERC20 is ERC20 {
    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) { }

    function mint(
        address account,
        uint256 amount
    ) external {
        _mint(account, amount);
    }
}

contract MockStockToken is MockERC20 {
    error TokenPaused();

    bool public paused;
    uint256 public multiplierX18 = 1e18;

    constructor() MockERC20("Mock Stock Token", "MSTOCK") { }

    function setPaused(
        bool paused_
    ) external {
        paused = paused_;
    }

    function setMultiplierX18(
        uint256 multiplierX18_
    ) external {
        multiplierX18 = multiplierX18_;
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (paused && from != address(0) && to != address(0)) revert TokenPaused();
        super._update(from, to, value);
    }
}

contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE") { }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value / 100;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee);
    }
}

contract FalseReturnToken is MockERC20 {
    constructor() MockERC20("False Return Token", "FALSE") { }

    function transferFrom(
        address,
        address,
        uint256
    ) public pure override returns (bool) {
        return false;
    }
}

/// @dev Legacy-style ERC-20 whose mutating methods return no data.
contract NoReturnToken {
    string public constant name = "No Return Token";
    string public constant symbol = "NORETURN";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(
        address account,
        uint256 amount
    ) external {
        balanceOf[account] += amount;
        totalSupply += amount;
    }

    function approve(
        address spender,
        uint256 amount
    ) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(
        address recipient,
        uint256 amount
    ) external {
        _transfer(msg.sender, recipient, amount);
    }

    function transferFrom(
        address owner,
        address recipient,
        uint256 amount
    ) external {
        uint256 approved = allowance[owner][msg.sender];
        if (approved != type(uint256).max) allowance[owner][msg.sender] = approved - amount;
        _transfer(owner, recipient, amount);
    }

    function _transfer(
        address owner,
        address recipient,
        uint256 amount
    ) private {
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
    }
}

contract SixDecimalToken is MockERC20 {
    constructor() MockERC20("Six Decimal Token", "SIX") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract Mock1271Wallet is IERC1271, ERC1155Holder {
    address public immutable signer;

    constructor(
        address signer_
    ) {
        signer = signer_;
    }

    function approveToken(
        IERC20 token,
        address spender
    ) external {
        token.approve(spender, type(uint256).max);
    }

    function approveClaims(
        IERC1155 token,
        address operator
    ) external {
        token.setApprovalForAll(operator, true);
    }

    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(hash, signature);
        return error == ECDSA.RecoverError.NoError && recovered == signer
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }
}
