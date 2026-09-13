// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { OrderValidator } from "../src/OrderValidator.sol";
import { PriceMath } from "../src/libraries/PriceMath.sol";
import { Branch, FundingKind, Order, Side, TimeInForce } from "../src/types/ProtocolTypes.sol";
import { TestBase } from "./TestBase.sol";

contract GoldenVectorsTest is TestBase {
    string private vectors;

    function setUp() public {
        vectors = vm.readFile("../domain/fixtures/golden-vectors.json");
    }

    function testSolidityMatchesCommittedMarketAndConditionVectors() public view {
        uint256 configuredChainId = vm.parseJsonUint(vectors, ".market.inputs.robinhoodChainId");
        assertEq(block.chainid, configuredChainId, "fixture chain id");
        bytes32 marketId = keccak256(
            abi.encode(
                uint32(vm.parseJsonUint(vectors, ".market.inputs.protocolVersion")),
                configuredChainId,
                vm.parseJsonAddress(vectors, ".market.inputs.baseToken"),
                vm.parseJsonAddress(vectors, ".market.inputs.quoteToken"),
                vm.parseJsonUint(vectors, ".market.inputs.polygonChainId"),
                vm.parseJsonBytes32(vectors, ".market.inputs.polymarketConditionId"),
                vm.parseJsonUint(vectors, ".market.inputs.polymarketYesIndex"),
                vm.parseJsonUint(vectors, ".market.inputs.polymarketNoIndex"),
                uint64(vm.parseJsonUint(vectors, ".market.inputs.tradingOpen")),
                uint64(vm.parseJsonUint(vectors, ".market.inputs.tradingCutoff")),
                vm.parseJsonBytes32(vectors, ".market.inputs.rulesHash")
            )
        );
        assertEq(
            marketId, vm.parseJsonBytes32(vectors, ".market.expectedMarketId"), "market vector"
        );

        bytes32 questionId = keccak256(abi.encode("CONDITIONAL_STOCKS_V2", marketId));
        assertEq(
            questionId, vm.parseJsonBytes32(vectors, ".condition.questionId"), "question vector"
        );
        bytes32 conditionId = keccak256(
            abi.encodePacked(
                vm.parseJsonAddress(vectors, ".condition.resolutionController"),
                questionId,
                uint256(2)
            )
        );
        assertEq(
            conditionId, vm.parseJsonBytes32(vectors, ".condition.conditionId"), "condition vector"
        );
    }

    function testSolidityMatchesCommittedOrderVector() public {
        address exchangeAddress = vm.parseJsonAddress(vectors, ".order.exchange");
        vm.etch(exchangeAddress, hex"00");
        OrderValidator validator = new OrderValidator(exchangeAddress);
        Order memory order = Order({
            maker: vm.parseJsonAddress(vectors, ".order.inputs.maker"),
            recipient: vm.parseJsonAddress(vectors, ".order.inputs.recipient"),
            marketId: vm.parseJsonBytes32(vectors, ".order.inputs.marketId"),
            branch: Branch(uint8(vm.parseJsonUint(vectors, ".order.inputs.branch"))),
            side: Side(uint8(vm.parseJsonUint(vectors, ".order.inputs.side"))),
            fundingKind: FundingKind(uint8(vm.parseJsonUint(vectors, ".order.inputs.fundingKind"))),
            quantity: uint128(vm.parseJsonUint(vectors, ".order.inputs.quantity")),
            limitPriceRawX18: uint128(vm.parseJsonUint(vectors, ".order.inputs.limitPriceRawX18")),
            tif: TimeInForce(uint8(vm.parseJsonUint(vectors, ".order.inputs.tif"))),
            expiry: uint64(vm.parseJsonUint(vectors, ".order.inputs.expiry")),
            nonce: uint64(vm.parseJsonUint(vectors, ".order.inputs.nonce")),
            salt: vm.parseJsonBytes32(vectors, ".order.inputs.salt"),
            maxFeeBps: uint16(vm.parseJsonUint(vectors, ".order.inputs.maxFeeBps"))
        });
        assertEq(
            validator.hashOrder(order),
            vm.parseJsonBytes32(vectors, ".order.expectedOrderHash"),
            "order vector"
        );
    }

    function testSolidityMatchesCommittedRoundingVector() public view {
        uint256 quantity = vm.parseJsonUint(vectors, ".math.quantity");
        uint256 priceRawX18 = vm.parseJsonUint(vectors, ".math.priceRawX18");
        assertEq(
            PriceMath.quoteDown(quantity, priceRawX18),
            vm.parseJsonUint(vectors, ".math.executionQuote"),
            "execution vector"
        );
        assertEq(
            PriceMath.quoteUp(quantity, priceRawX18),
            vm.parseJsonUint(vectors, ".math.reservationQuote"),
            "reservation vector"
        );
    }
}
