// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AtomicOrderRouter } from "../src/AtomicOrderRouter.sol";
import { ConditionalExchange } from "../src/ConditionalExchange.sol";
import { ConditionalSettlement } from "../src/ConditionalSettlement.sol";
import { ManualResolutionController } from "../src/ManualResolutionController.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";
import { OrderRecoveryRouter } from "../src/OrderRecoveryRouter.sol";
import { OrderValidator } from "../src/OrderValidator.sol";
import { PositionRouter } from "../src/PositionRouter.sol";
import { ProtocolAuthority } from "../src/ProtocolAuthority.sol";
import { ProtocolFeeVault } from "../src/ProtocolFeeVault.sol";
import { IAtomicExchange } from "../src/interfaces/IAtomicExchange.sol";
import { IAtomicOrderRouter } from "../src/interfaces/IAtomicOrderRouter.sol";
import { IConditionalSettlement } from "../src/interfaces/IConditionalSettlement.sol";
import { IConditionalTokens } from "../src/interfaces/IConditionalTokens.sol";
import { IOrderRecoveryExchange } from "../src/interfaces/IOrderRecoveryExchange.sol";
import { IProtocolAuthority } from "../src/interfaces/IProtocolAuthority.sol";
import { ProtocolConstants } from "../src/libraries/ProtocolConstants.sol";
import {
    Branch,
    FundingKind,
    Market,
    MarketConfig,
    Order,
    Payout,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { TestBase } from "./TestBase.sol";
import { MockERC20, MockStockToken } from "./mocks/MockTokens.sol";

abstract contract ProtocolFixture is TestBase {
    uint256 internal constant BUYER_KEY = 0xA11CE;
    uint256 internal constant SELLER_KEY = 0xB0B;
    uint256 internal constant SECOND_BUYER_KEY = 0xCAFE;
    uint256 internal constant WAD = 1e18;

    address internal buyer;
    address internal seller;
    address internal secondBuyer;

    IConditionalTokens internal ctf;
    ProtocolAuthority internal authority;
    MarketRegistry internal registry;
    ManualResolutionController internal resolutionController;
    ConditionalExchange internal exchange;
    ConditionalSettlement internal settlement;
    ProtocolFeeVault internal feeVault;
    OrderValidator internal validator;
    AtomicOrderRouter internal atomicRouter;
    OrderRecoveryRouter internal recoveryRouter;
    PositionRouter internal positionRouter;
    MockStockToken internal stock;
    MockERC20 internal quote;

    bytes32 internal marketId;
    Market internal market;
    uint64 internal cutoff;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);
        secondBuyer = vm.addr(SECOND_BUYER_KEY);

        ctf = _deployConditionalTokens();
        stock = new MockStockToken();
        quote = _newQuoteToken();
        authority =
            new ProtocolAuthority(address(this), address(this), address(this), address(this));
        IProtocolAuthority protocolAuthority = IProtocolAuthority(address(authority));
        registry = new MarketRegistry(ctf, protocolAuthority, quote);
        resolutionController = new ManualResolutionController(ctf, registry, protocolAuthority);
        registry.setResolutionController(address(resolutionController));

        exchange = new ConditionalExchange(ctf, registry, protocolAuthority);
        validator = new OrderValidator(address(exchange));
        feeVault = new ProtocolFeeVault(ctf, protocolAuthority);
        settlement = new ConditionalSettlement(ctf, registry, address(exchange), feeVault);
        atomicRouter = new AtomicOrderRouter(IAtomicExchange(address(exchange)), protocolAuthority);
        recoveryRouter = new OrderRecoveryRouter(IOrderRecoveryExchange(address(exchange)));
        exchange.configureOrderValidator(validator);
        exchange.configureSettlement(IConditionalSettlement(address(settlement)));
        exchange.configureAtomicRouter(IAtomicOrderRouter(address(atomicRouter)));
        positionRouter = new PositionRouter(ctf);

        cutoff = uint64(block.timestamp + 30 days);
        string memory metadataUri = "ipfs://conditional-stocks/test-market";
        MarketConfig memory config = MarketConfig({
            baseToken: address(stock),
            quoteToken: address(quote),
            polymarketConditionId: keccak256("POLYMARKET_TEST_CONDITION"),
            polymarketYesIndex: ProtocolConstants.YES_INDEX_SET,
            polymarketNoIndex: ProtocolConstants.NO_INDEX_SET,
            tradingOpen: uint64(block.timestamp),
            tradingCutoff: cutoff,
            rulesHash: keccak256("TEST_RULES_V1"),
            metadataHash: keccak256(bytes(metadataUri)),
            priceTickRawX18: uint128(_quoteUnit() / 100),
            baseStep: uint128(0.001e18),
            minNotional: uint128(_quoteUnit() / 100),
            maxOrderQuantity: uint128(1_000e18),
            maxOrderNotional: uint128(1_000_000 * _quoteUnit()),
            maxWalletOpenNotional: uint128(5_000_000 * _quoteUnit()),
            maxMarketOpenNotional: uint128(50_000_000 * _quoteUnit())
        });
        marketId = registry.createMarket(config, metadataUri);
        registry.openMarket(marketId);
        market = registry.getMarket(marketId);

        stock.mint(seller, 10_000e18);
        stock.mint(buyer, 10_000e18);
        quote.mint(buyer, 10_000_000 * _quoteUnit());
        quote.mint(secondBuyer, 10_000_000 * _quoteUnit());
        quote.mint(seller, 10_000_000 * _quoteUnit());

        _approveAll(buyer);
        _approveAll(seller);
        _approveAll(secondBuyer);
    }

    function _quoteUnit() internal pure virtual returns (uint256) {
        return 1e18;
    }

    function _newQuoteToken() internal virtual returns (MockERC20) {
        return new MockERC20("Mock quote", "QUOTE");
    }

    function _deployConditionalTokens() private returns (IConditionalTokens deployed) {
        string memory artifact = vm.readFile(
            "node_modules/@gnosis.pm/conditional-tokens-contracts/build/contracts/ConditionalTokens.json"
        );
        bytes memory creationCode = vm.parseJsonBytes(artifact, ".bytecode");
        address deployment;
        assembly ("memory-safe") {
            deployment := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        assertTrue(deployment != address(0), "CTF artifact deployment failed");
        deployed = IConditionalTokens(deployment);
    }

    function _approveAll(
        address account
    ) private {
        vm.startPrank(account);
        stock.approve(address(exchange), type(uint256).max);
        quote.approve(address(exchange), type(uint256).max);
        stock.approve(address(ctf), type(uint256).max);
        quote.approve(address(ctf), type(uint256).max);
        ctf.setApprovalForAll(address(exchange), true);
        ctf.setApprovalForAll(address(positionRouter), true);
        vm.stopPrank();
    }

    function _order(
        address maker,
        Branch branch,
        Side side,
        FundingKind fundingKind,
        uint128 quantity,
        uint128 priceRawX18,
        TimeInForce tif,
        uint64 nonce,
        bytes32 salt
    ) internal view returns (Order memory) {
        return Order({
            maker: maker,
            recipient: maker,
            marketId: marketId,
            branch: branch,
            side: side,
            fundingKind: fundingKind,
            quantity: quantity,
            limitPriceRawX18: priceRawX18,
            tif: tif,
            expiry: cutoff - 1,
            nonce: nonce,
            salt: salt,
            maxFeeBps: 0
        });
    }

    function _sign(
        Order memory order,
        uint256 privateKey
    ) internal returns (bytes memory) {
        bytes32 digest = exchange.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _splitFor(
        address account,
        IERC20 collateral,
        uint256 amount
    ) internal {
        uint256[] memory partition = new uint256[](2);
        partition[0] = ProtocolConstants.YES_INDEX_SET;
        partition[1] = ProtocolConstants.NO_INDEX_SET;
        vm.prank(account);
        ctf.splitPosition(
            collateral,
            ProtocolConstants.PARENT_COLLECTION_ID,
            market.conditionId,
            partition,
            amount
        );
    }

    /// @dev All normal test placement uses the actual owner-authorized public router.
    function _openOrder(
        Order memory order,
        bytes memory signature
    ) internal returns (bytes32) {
        vm.prank(order.maker);
        return atomicRouter.placeAndMatch(
            order,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            order.expiry < block.timestamp + 60 ? order.expiry : uint64(block.timestamp + 60)
        );
    }

    /// @dev Unit-test the exchange settlement kernel independently of router plan validation.
    /// Production callers cannot impersonate the immutable router. Atomic integration tests
    /// exercise the complete public entry point, including multi-leg rollback and authorization.
    function _matchOrders(
        Order memory bid,
        Order memory ask,
        uint128 quantity
    ) internal {
        vm.startPrank(address(atomicRouter));
        Payout[5] memory leg = exchange.matchOrders(bid, ask, quantity);
        Payout[] memory payouts = new Payout[](5);
        for (uint256 i; i < 5; ++i) {
            payouts[i] = leg[i];
        }
        exchange.finalizeAtomicPlacement(exchange.hashOrder(bid), payouts);
        vm.stopPrank();
    }

    function _executeIOC(
        Order memory taker,
        bytes memory signature,
        Order[] memory makers,
        uint128[] memory amounts
    ) internal returns (bytes32) {
        uint128[] memory remaining = new uint128[](makers.length);
        for (uint256 i; i < makers.length; ++i) {
            remaining[i] = makers[i].quantity;
        }
        vm.prank(taker.maker);
        return atomicRouter.placeAndMatch(
            taker,
            signature,
            makers,
            amounts,
            remaining,
            taker.expiry < block.timestamp + 60 ? taker.expiry : uint64(block.timestamp + 60)
        );
    }
}
