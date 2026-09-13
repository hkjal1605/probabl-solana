// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IConditionalTokens } from "./interfaces/IConditionalTokens.sol";
import { IManualResolutionController } from "./interfaces/IManualResolutionController.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { IProtocolAuthority } from "./interfaces/IProtocolAuthority.sol";
import { MarketConfigMath } from "./libraries/MarketConfigMath.sol";
import { PriceMath } from "./libraries/PriceMath.sol";
import { ProtocolConstants } from "./libraries/ProtocolConstants.sol";
import { ProtocolRoles } from "./libraries/ProtocolRoles.sol";
import { Market, MarketConfig, MarketState } from "./types/ProtocolTypes.sol";
import { ProtocolAccess } from "./utils/ProtocolAccess.sol";

/// @notice Registry of immutable v2 raw-unit market terms and lifecycle state.
/// @dev The deployment-time quote token is the only quote collateral accepted by any market.
contract MarketRegistry is ProtocolAccess, IMarketRegistry {
    error AlreadyConfigured();
    error InvalidAddress();
    error InvalidMarketConfig();
    error InvalidPreparedCondition(bytes32 conditionId);
    error InvalidMarketState(bytes32 marketId, MarketState expected, MarketState actual);
    error MarketAlreadyExists(bytes32 marketId);
    error MarketNotFound(bytes32 marketId);
    error ResolutionControllerNotConfigured();
    error UnauthorizedLifecycleCaller(address caller);

    event ResolutionControllerConfigured(address indexed controller);
    event ResolutionPrepared(bytes32 indexed marketId, bytes32 indexed commitment);
    event MarketCreated(
        bytes32 indexed marketId,
        address indexed baseToken,
        address indexed quoteToken,
        bytes32 localQuestionId,
        bytes32 conditionId,
        bytes32 polymarketConditionId,
        bytes32 rulesHash,
        bytes32 metadataHash,
        string metadataUri,
        uint32 protocolVersion
    );
    event MarketTermsConfigured(
        bytes32 indexed marketId,
        uint256 polymarketYesIndex,
        uint256 polymarketNoIndex,
        uint64 tradingOpen,
        uint64 tradingCutoff,
        uint128 priceTickRawX18,
        uint128 baseStep,
        uint128 minNotional,
        uint128 maxOrderQuantity,
        uint128 maxOrderNotional,
        uint128 maxWalletOpenNotional,
        uint128 maxMarketOpenNotional
    );
    event MarketPositionsConfigured(
        bytes32 indexed marketId,
        uint256 stockYesPositionId,
        uint256 stockNoPositionId,
        uint256 quoteYesPositionId,
        uint256 quoteNoPositionId
    );
    event MarketStateChanged(
        bytes32 indexed marketId,
        MarketState indexed previousState,
        MarketState indexed newState,
        bytes32 reasonHash
    );

    bytes32 public constant DEFAULT_ADMIN_ROLE = ProtocolRoles.DEFAULT_ADMIN_ROLE;
    bytes32 public constant MARKET_ADMIN_ROLE = ProtocolRoles.MARKET_ADMIN_ROLE;
    bytes32 public constant GUARDIAN_ROLE = ProtocolRoles.GUARDIAN_ROLE;
    uint32 public constant PROTOCOL_VERSION = ProtocolConstants.PROTOCOL_VERSION;
    uint256 public constant POLYGON_CHAIN_ID = ProtocolConstants.POLYGON_CHAIN_ID;
    uint256 public constant MAX_METADATA_URI_LENGTH = 512;

    IConditionalTokens public immutable ctf;
    IERC20 public immutable quoteToken;
    address public override resolutionController;
    uint256 public marketCount;

    mapping(bytes32 marketId => Market market) private _markets;
    mapping(bytes32 marketId => bytes32 commitment) public override resolutionCommitments;

    constructor(
        IConditionalTokens ctf_,
        IProtocolAuthority authority_,
        IERC20 quoteToken_
    ) ProtocolAccess(authority_) {
        if (
            address(ctf_) == address(0) || address(ctf_).code.length == 0
                || address(quoteToken_) == address(0) || address(quoteToken_).code.length == 0
        ) {
            revert InvalidAddress();
        }

        ctf = ctf_;
        quoteToken = quoteToken_;
    }

    function setResolutionController(
        address controller
    ) external onlyProtocolRole(DEFAULT_ADMIN_ROLE) {
        if (controller == address(0) || controller.code.length == 0) revert InvalidAddress();
        if (resolutionController != address(0) || marketCount != 0) revert AlreadyConfigured();
        IManualResolutionController candidate = IManualResolutionController(controller);
        if (
            candidate.CONTROLLER_VERSION() != 1 || address(candidate.ctf()) != address(ctf)
                || address(candidate.registry()) != address(this)
                || address(candidate.authority()) != address(authority)
        ) {
            revert InvalidAddress();
        }
        resolutionController = controller;
        emit ResolutionControllerConfigured(controller);
    }

    function createMarket(
        MarketConfig calldata config,
        string calldata metadataUri
    ) external onlyProtocolRole(MARKET_ADMIN_ROLE) returns (bytes32 marketId) {
        address controller = resolutionController;
        if (controller == address(0)) revert ResolutionControllerNotConfigured();
        _validateConfig(config, metadataUri);

        marketId = computeMarketId(config);
        if (_markets[marketId].state != MarketState.NONE) revert MarketAlreadyExists(marketId);

        bytes32 localQuestionId = keccak256(abi.encode("CONDITIONAL_STOCKS_V2", marketId));
        bytes32 conditionId =
            ctf.getConditionId(controller, localQuestionId, ProtocolConstants.OUTCOME_SLOT_COUNT);
        uint256 slotCount = ctf.getOutcomeSlotCount(conditionId);
        if (slotCount == 0) {
            ctf.prepareCondition(controller, localQuestionId, ProtocolConstants.OUTCOME_SLOT_COUNT);
            slotCount = ctf.getOutcomeSlotCount(conditionId);
        }
        if (
            slotCount != ProtocolConstants.OUTCOME_SLOT_COUNT
                || ctf.payoutDenominator(conditionId) != 0
                || ctf.payoutNumerators(conditionId, 0) != 0
                || ctf.payoutNumerators(conditionId, 1) != 0
        ) revert InvalidPreparedCondition(conditionId);

        uint256 stockYesPositionId =
            _positionId(config.baseToken, conditionId, ProtocolConstants.YES_INDEX_SET);
        uint256 stockNoPositionId =
            _positionId(config.baseToken, conditionId, ProtocolConstants.NO_INDEX_SET);
        uint256 quoteYesPositionId =
            _positionId(config.quoteToken, conditionId, ProtocolConstants.YES_INDEX_SET);
        uint256 quoteNoPositionId =
            _positionId(config.quoteToken, conditionId, ProtocolConstants.NO_INDEX_SET);

        _markets[marketId] = Market({
            baseToken: config.baseToken,
            quoteToken: config.quoteToken,
            localQuestionId: localQuestionId,
            conditionId: conditionId,
            polymarketConditionId: config.polymarketConditionId,
            rulesHash: config.rulesHash,
            metadataHash: config.metadataHash,
            polymarketYesIndex: config.polymarketYesIndex,
            polymarketNoIndex: config.polymarketNoIndex,
            stockYesPositionId: stockYesPositionId,
            stockNoPositionId: stockNoPositionId,
            quoteYesPositionId: quoteYesPositionId,
            quoteNoPositionId: quoteNoPositionId,
            tradingOpen: config.tradingOpen,
            tradingCutoff: config.tradingCutoff,
            priceTickRawX18: config.priceTickRawX18,
            baseStep: config.baseStep,
            minNotional: config.minNotional,
            maxOrderQuantity: config.maxOrderQuantity,
            maxOrderNotional: config.maxOrderNotional,
            maxWalletOpenNotional: config.maxWalletOpenNotional,
            maxMarketOpenNotional: config.maxMarketOpenNotional,
            state: MarketState.SCHEDULED
        });

        unchecked {
            ++marketCount;
        }

        emit MarketCreated(
            marketId,
            config.baseToken,
            config.quoteToken,
            localQuestionId,
            conditionId,
            config.polymarketConditionId,
            config.rulesHash,
            config.metadataHash,
            metadataUri,
            PROTOCOL_VERSION
        );
        emit MarketTermsConfigured(
            marketId,
            config.polymarketYesIndex,
            config.polymarketNoIndex,
            config.tradingOpen,
            config.tradingCutoff,
            config.priceTickRawX18,
            config.baseStep,
            config.minNotional,
            config.maxOrderQuantity,
            config.maxOrderNotional,
            config.maxWalletOpenNotional,
            config.maxMarketOpenNotional
        );
        emit MarketPositionsConfigured(
            marketId, stockYesPositionId, stockNoPositionId, quoteYesPositionId, quoteNoPositionId
        );
        emit MarketStateChanged(marketId, MarketState.NONE, MarketState.SCHEDULED, bytes32(0));
    }

    function openMarket(
        bytes32 marketId
    ) external onlyProtocolRole(MARKET_ADMIN_ROLE) {
        Market storage market = _marketStorage(marketId);
        _requireState(marketId, market.state, MarketState.SCHEDULED);
        if (block.timestamp < market.tradingOpen || block.timestamp >= market.tradingCutoff) {
            revert InvalidMarketConfig();
        }
        _setState(marketId, market, MarketState.OPEN, bytes32(0));
    }

    function freezeMarket(
        bytes32 marketId,
        bytes32 reasonHash
    ) external {
        if (
            !authority.hasRole(GUARDIAN_ROLE, msg.sender)
                && !authority.hasRole(MARKET_ADMIN_ROLE, msg.sender)
        ) {
            revert UnauthorizedLifecycleCaller(msg.sender);
        }
        if (reasonHash == bytes32(0)) revert InvalidMarketConfig();

        Market storage market = _marketStorage(marketId);
        MarketState current = market.state;
        if (current != MarketState.SCHEDULED && current != MarketState.OPEN) {
            revert InvalidMarketState(marketId, MarketState.OPEN, current);
        }
        _setState(marketId, market, MarketState.FROZEN, reasonHash);
    }

    function freezeAtCutoff(
        bytes32 marketId
    ) external {
        Market storage market = _marketStorage(marketId);
        _requireState(marketId, market.state, MarketState.OPEN);
        if (block.timestamp < market.tradingCutoff) revert InvalidMarketConfig();
        _setState(marketId, market, MarketState.FROZEN, keccak256("TRADING_CUTOFF"));
    }

    function beginResolution(
        bytes32 marketId,
        bytes32 resolutionCommitment
    ) external onlyProtocolRole(MARKET_ADMIN_ROLE) {
        if (resolutionCommitment == bytes32(0)) revert InvalidMarketConfig();
        Market storage market = _marketStorage(marketId);
        _requireState(marketId, market.state, MarketState.FROZEN);
        resolutionCommitments[marketId] = resolutionCommitment;
        emit ResolutionPrepared(marketId, resolutionCommitment);
        _setState(marketId, market, MarketState.AWAITING_RESOLUTION, resolutionCommitment);
    }

    function markResolved(
        bytes32 marketId
    ) external override {
        _requireResolutionController();
        Market storage market = _marketStorage(marketId);
        _requireState(marketId, market.state, MarketState.AWAITING_RESOLUTION);
        delete resolutionCommitments[marketId];
        _setState(marketId, market, MarketState.RESOLVED, bytes32(0));
    }

    function markRedeemable(
        bytes32 marketId
    ) external override {
        _requireResolutionController();
        Market storage market = _marketStorage(marketId);
        _requireState(marketId, market.state, MarketState.RESOLVED);
        _setState(marketId, market, MarketState.REDEEMABLE, bytes32(0));
    }

    function archiveMarket(
        bytes32 marketId,
        bytes32 reasonHash
    ) external onlyProtocolRole(MARKET_ADMIN_ROLE) {
        if (reasonHash == bytes32(0)) revert InvalidMarketConfig();
        Market storage market = _marketStorage(marketId);
        _requireState(marketId, market.state, MarketState.REDEEMABLE);
        _setState(marketId, market, MarketState.ARCHIVED, reasonHash);
    }

    function computeMarketId(
        MarketConfig calldata config
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                ProtocolConstants.PROTOCOL_VERSION,
                block.chainid,
                config.baseToken,
                config.quoteToken,
                ProtocolConstants.POLYGON_CHAIN_ID,
                config.polymarketConditionId,
                config.polymarketYesIndex,
                config.polymarketNoIndex,
                config.tradingOpen,
                config.tradingCutoff,
                config.rulesHash
            )
        );
    }

    function getMarket(
        bytes32 marketId
    ) external view override returns (Market memory market) {
        market = _markets[marketId];
        if (market.state == MarketState.NONE) revert MarketNotFound(marketId);
    }

    function marketState(
        bytes32 marketId
    ) external view override returns (MarketState state) {
        state = _markets[marketId].state;
        if (state == MarketState.NONE) revert MarketNotFound(marketId);
    }

    function isTradingOpen(
        bytes32 marketId
    ) external view override returns (bool) {
        Market storage market = _markets[marketId];
        return market.state == MarketState.OPEN && block.timestamp >= market.tradingOpen
            && block.timestamp < market.tradingCutoff;
    }

    function _positionId(
        address collateral,
        bytes32 conditionId,
        uint256 indexSet
    ) private view returns (uint256) {
        bytes32 collectionId =
            ctf.getCollectionId(ProtocolConstants.PARENT_COLLECTION_ID, conditionId, indexSet);
        return ctf.getPositionId(IERC20(collateral), collectionId);
    }

    function _validateConfig(
        MarketConfig calldata config,
        string calldata metadataUri
    ) private view {
        if (
            config.baseToken == address(0) || config.quoteToken != address(quoteToken)
                || config.baseToken == config.quoteToken || config.baseToken.code.length == 0
                || config.quoteToken.code.length == 0
        ) revert InvalidMarketConfig();

        bool indexesValid =
            (config.polymarketYesIndex == ProtocolConstants.YES_INDEX_SET
                    && config.polymarketNoIndex == ProtocolConstants.NO_INDEX_SET)
                || (config.polymarketYesIndex == ProtocolConstants.NO_INDEX_SET
                    && config.polymarketNoIndex == ProtocolConstants.YES_INDEX_SET);
        if (
            !indexesValid || config.polymarketConditionId == bytes32(0)
                || config.rulesHash == bytes32(0) || config.metadataHash == bytes32(0)
                || bytes(metadataUri).length == 0
                || bytes(metadataUri).length > MAX_METADATA_URI_LENGTH
                || keccak256(bytes(metadataUri)) != config.metadataHash
                || config.tradingCutoff <= config.tradingOpen
                || config.tradingCutoff <= block.timestamp || config.priceTickRawX18 == 0
                || config.baseStep == 0 || config.minNotional == 0
                || config.maxOrderQuantity < config.baseStep
                || config.maxOrderNotional < config.minNotional
                || config.maxWalletOpenNotional < config.maxOrderNotional
                || config.maxMarketOpenNotional < config.maxWalletOpenNotional
        ) revert InvalidMarketConfig();

        if (PriceMath.quoteDown(config.baseStep, config.priceTickRawX18) == 0) {
            revert InvalidMarketConfig();
        }
        (uint256 minimumPrice, uint256 minimumOrderNotional) = MarketConfigMath.minimumOrderAtBaseStep(
            config.baseStep, config.priceTickRawX18, config.minNotional
        );
        if (
            minimumPrice > type(uint128).max || minimumOrderNotional > config.maxOrderNotional
                || uint256(config.maxMarketOpenNotional) < 2 * minimumOrderNotional
        ) revert InvalidMarketConfig();
    }

    function _marketStorage(
        bytes32 marketId
    ) private view returns (Market storage market) {
        market = _markets[marketId];
        if (market.state == MarketState.NONE) revert MarketNotFound(marketId);
    }

    function _requireState(
        bytes32 marketId,
        MarketState actual,
        MarketState expected
    ) private pure {
        if (actual != expected) revert InvalidMarketState(marketId, expected, actual);
    }

    function _setState(
        bytes32 marketId,
        Market storage market,
        MarketState next,
        bytes32 reasonHash
    ) private {
        MarketState previous = market.state;
        market.state = next;
        emit MarketStateChanged(marketId, previous, next, reasonHash);
    }

    function _requireResolutionController() private view {
        if (msg.sender != resolutionController) revert UnauthorizedLifecycleCaller(msg.sender);
    }
}
