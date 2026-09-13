// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { ERC165Checker } from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import { IOrderValidator } from "./interfaces/IOrderValidator.sol";
import { FeeMath } from "./libraries/FeeMath.sol";
import { Order } from "./types/ProtocolTypes.sol";

/// @notice Verifies v3 fee-capped orders; prices remain raw quote / raw base scaled by 1e18.
/// @dev The EIP-712 verifying contract is the exchange, not this stateless helper.
contract OrderValidator is IOrderValidator {
    error InvalidAddress();
    error InvalidSignature();
    error InvalidFeeCap();
    error UnsupportedClaimDestination(address destination);

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant NAME_HASH = keccak256("ConditionalExchange");
    bytes32 public constant VERSION_HASH = keccak256("3");
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address recipient,bytes32 marketId,uint8 branch,uint8 side,uint8 fundingKind,uint128 quantity,uint128 limitPriceRawX18,uint8 tif,uint64 expiry,uint64 nonce,bytes32 salt,uint16 maxFeeBps)"
    );

    address public immutable override exchange;

    constructor(
        address exchange_
    ) {
        if (exchange_ == address(0) || exchange_.code.length == 0) revert InvalidAddress();
        exchange = exchange_;
    }

    function hashOrder(
        Order calldata order
    ) public view override returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.maker,
                order.recipient,
                order.marketId,
                uint8(order.branch),
                uint8(order.side),
                uint8(order.fundingKind),
                order.quantity,
                order.limitPriceRawX18,
                uint8(order.tif),
                order.expiry,
                order.nonce,
                order.salt,
                order.maxFeeBps
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, exchange)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function validate(
        Order calldata order,
        bytes calldata signature
    ) external view override returns (bytes32 orderHash) {
        if (order.maxFeeBps > FeeMath.MAX_FEE_BPS) revert InvalidFeeCap();
        // Both makers can receive inactive claims, price improvement, or cancelled claim escrow.
        // ERC-165 detects incompatibility only at open time; clients must still simulate fills.
        _requireClaimDestination(order.maker);
        if (order.recipient != order.maker) _requireClaimDestination(order.recipient);
        orderHash = hashOrder(order);
        if (order.maker.code.length == 0) {
            (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(orderHash, signature);
            if (error != ECDSA.RecoverError.NoError || recovered != order.maker) {
                revert InvalidSignature();
            }
        } else {
            (bool success, bytes memory result) = order.maker
                .staticcall(abi.encodeCall(IERC1271.isValidSignature, (orderHash, signature)));
            if (
                !success || result.length < 32
                    || abi.decode(result, (bytes32)) != bytes32(IERC1271.isValidSignature.selector)
            ) revert InvalidSignature();
        }
    }

    function _requireClaimDestination(
        address destination
    ) private view {
        if (
            destination.code.length != 0
                && !ERC165Checker.supportsInterface(destination, type(IERC1155Receiver).interfaceId)
        ) revert UnsupportedClaimDestination(destination);
    }
}
