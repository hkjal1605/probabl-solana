// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { AtomicOrderRouter } from "../src/AtomicOrderRouter.sol";
import { ConditionalExchange } from "../src/ConditionalExchange.sol";
import { ManualResolutionController } from "../src/ManualResolutionController.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";
import { ProtocolAuthority } from "../src/ProtocolAuthority.sol";
import { IAtomicExchange } from "../src/interfaces/IAtomicExchange.sol";
import { IConditionalTokens } from "../src/interfaces/IConditionalTokens.sol";
import { IProtocolAuthority } from "../src/interfaces/IProtocolAuthority.sol";
import { MarketConfigMath } from "../src/libraries/MarketConfigMath.sol";
import {
    Branch,
    FundingKind,
    MarketConfig,
    Order,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";

contract WrongAuthorityController {
    uint32 public constant CONTROLLER_VERSION = 1;
    IConditionalTokens public immutable ctf;
    MarketRegistry public immutable registry;
    IProtocolAuthority public immutable authority;

    constructor(
        IConditionalTokens c,
        MarketRegistry r,
        IProtocolAuthority a
    ) {
        ctf = c;
        registry = r;
        authority = a;
    }
}

contract RegistryHardeningTest is ProtocolFixture {
    function _config(
        string memory uri
    ) private view returns (MarketConfig memory) {
        return MarketConfig({
            baseToken: address(stock),
            quoteToken: address(quote),
            polymarketConditionId: keccak256(bytes(uri)),
            polymarketYesIndex: 1,
            polymarketNoIndex: 2,
            tradingOpen: uint64(block.timestamp),
            tradingCutoff: cutoff,
            rulesHash: keccak256("HARDENED_RULES"),
            metadataHash: keccak256(bytes(uri)),
            priceTickRawX18: 1e18,
            baseStep: 1e18,
            minNotional: 1e18,
            maxOrderQuantity: 1e18,
            maxOrderNotional: 100e18,
            maxWalletOpenNotional: 100e18,
            maxMarketOpenNotional: 200e18
        });
    }

    function testPreResolvedConditionIsRejectedAndNoMarketIsStored() public {
        string memory uri = "ipfs://pre-resolved";
        MarketConfig memory config = _config(uri);
        bytes32 id = registry.computeMarketId(config);
        bytes32 question = keccak256(abi.encode("CONDITIONAL_STOCKS_V2", id));
        bytes32 condition = ctf.getConditionId(address(resolutionController), question, 2);
        ctf.prepareCondition(address(resolutionController), question, 2);
        uint256[] memory payouts = new uint256[](2);
        payouts[0] = 1;
        // Defensive malformed-dependency state; an outsider cannot impersonate the oracle onchain.
        vm.prank(address(resolutionController));
        ctf.reportPayouts(question, payouts);
        uint256 count = registry.marketCount();
        vm.expectRevert(
            abi.encodeWithSelector(MarketRegistry.InvalidPreparedCondition.selector, condition)
        );
        registry.createMarket(config, uri);
        assertEq(registry.marketCount(), count, "no market recorded");
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.MarketNotFound.selector, id));
        registry.getMarket(id);
    }

    function testMalformedPreparedSlotCountIsRejected() public {
        string memory uri = "ipfs://malformed-condition";
        MarketConfig memory config = _config(uri);
        bytes32 id = registry.computeMarketId(config);
        bytes32 condition = ctf.getConditionId(
            address(resolutionController), keccak256(abi.encode("CONDITIONAL_STOCKS_V2", id)), 2
        );
        vm.mockCall(
            address(ctf),
            abi.encodeCall(IConditionalTokens.getOutcomeSlotCount, (condition)),
            abi.encode(uint256(3))
        );
        vm.expectRevert(
            abi.encodeWithSelector(MarketRegistry.InvalidPreparedCondition.selector, condition)
        );
        registry.createMarket(config, uri);
        vm.clearMockedCalls();
    }

    function testAllSharedAuthorityWiringRejectsASecondAuthority() public {
        IProtocolAuthority other =
            IProtocolAuthority(address(new ProtocolAuthority(buyer, buyer, buyer, buyer)));
        vm.expectRevert(ConditionalExchange.InvalidAddress.selector);
        new ConditionalExchange(ctf, registry, other);
        vm.expectRevert(ManualResolutionController.InvalidAddress.selector);
        new ManualResolutionController(ctf, registry, other);
        vm.expectRevert(AtomicOrderRouter.InvalidAddress.selector);
        new AtomicOrderRouter(IAtomicExchange(address(exchange)), other);
        MarketRegistry fresh =
            new MarketRegistry(ctf, IProtocolAuthority(address(authority)), quote);
        WrongAuthorityController wrong = new WrongAuthorityController(ctf, fresh, other);
        vm.expectRevert(MarketRegistry.InvalidAddress.selector);
        fresh.setResolutionController(address(wrong));
        assertEq(fresh.resolutionController(), address(0), "wiring remains unset");
    }

    /// forge-config: default.fuzz.runs = 64
    /// forge-config: ci.fuzz.runs = 256
    function testFuzzAcceptedCapsAdmitAnActualTwoSidedFill(
        uint64 rawStep,
        uint64 rawTick,
        uint96 rawMinimum
    ) public {
        string memory uri = "ipfs://constructive-cap-test";
        MarketConfig memory config = _config(uri);
        config.baseStep = uint128(uint256(rawStep) % 1e18 + 1);
        config.priceTickRawX18 = uint128(uint256(rawTick) % 1e18 + 1);
        if (uint256(config.baseStep) * config.priceTickRawX18 < 1e18) {
            config.priceTickRawX18 = 1e18;
        }
        config.minNotional = uint128(uint256(rawMinimum) % 1e24 + 1);
        (uint256 price, uint256 notional) = MarketConfigMath.minimumOrderAtBaseStep(
            config.baseStep, config.priceTickRawX18, config.minNotional
        );
        if (price > type(uint128).max) {
            vm.expectRevert(MarketRegistry.InvalidMarketConfig.selector);
            registry.createMarket(config, uri);
            return;
        }
        config.maxOrderQuantity = config.baseStep;
        config.maxOrderNotional = SafeCast.toUint128(notional);
        config.maxWalletOpenNotional = SafeCast.toUint128(notional);
        config.maxMarketOpenNotional = SafeCast.toUint128(2 * notional);
        bytes32 id = registry.createMarket(config, uri);
        registry.openMarket(id);
        Order memory bid = _order(
            buyer,
            Branch.YES,
            Side.BUY,
            FundingKind.WHOLE_COLLATERAL,
            config.baseStep,
            SafeCast.toUint128(price),
            TimeInForce.GTC,
            0,
            keccak256("CAP_BID")
        );
        Order memory ask = _order(
            seller,
            Branch.YES,
            Side.SELL,
            FundingKind.WHOLE_COLLATERAL,
            config.baseStep,
            SafeCast.toUint128(price),
            TimeInForce.GTC,
            0,
            keccak256("CAP_ASK")
        );
        bid.marketId = id;
        ask.marketId = id;
        bytes32 bidHash = _openOrder(bid, _sign(bid, BUYER_KEY));
        _openOrder(ask, _sign(ask, SELLER_KEY));
        assertEq(exchange.marketOpenNotional(id), 2 * notional, "both orders fit exactly");
        _matchOrders(bid, ask, config.baseStep);
        assertEq(exchange.marketOpenNotional(id), 0, "both orders executed");
        assertEq(
            uint256(exchange.getOrderState(bidHash).status),
            uint256(OrderStatus.FILLED),
            "witness fills"
        );
    }

    function testUint128BoundariesFailWithConfigErrorInsteadOfOverflow() public {
        string memory uri = "ipfs://uint128-boundaries";
        MarketConfig memory config = _config(uri);
        config.baseStep = type(uint128).max;
        config.maxOrderQuantity = type(uint128).max;
        config.priceTickRawX18 = type(uint128).max;
        config.minNotional = type(uint128).max;
        config.maxOrderNotional = type(uint128).max;
        config.maxWalletOpenNotional = type(uint128).max;
        config.maxMarketOpenNotional = type(uint128).max;
        vm.expectRevert(MarketRegistry.InvalidMarketConfig.selector);
        registry.createMarket(config, uri);
        config.baseStep = 1;
        config.priceTickRawX18 = 1e18;
        vm.expectRevert(MarketRegistry.InvalidMarketConfig.selector);
        registry.createMarket(config, uri);
    }
}
