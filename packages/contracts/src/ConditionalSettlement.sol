// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { PayoutVault } from "./PayoutVault.sol";
import { ProtocolFeeVault } from "./ProtocolFeeVault.sol";
import { IAtomicExchange } from "./interfaces/IAtomicExchange.sol";
import { IConditionalTokens } from "./interfaces/IConditionalTokens.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { FeeMath } from "./libraries/FeeMath.sol";
import { ProtocolConstants } from "./libraries/ProtocolConstants.sol";
import {
    Branch,
    FundingKind,
    Market,
    MarketState,
    Payout,
    SettlementFill
} from "./types/ProtocolTypes.sol";
import { ExpectedCtfReceiver } from "./utils/ExpectedCtfReceiver.sol";

/// @notice Atomically materializes and delivers fills already authorized by the exchange.
/// @dev This contract has no admin, upgrade, recovery, or arbitrary transfer function. Its
///      immutable exchange is the only caller and the only address from which it can pull assets.
contract ConditionalSettlement is ExpectedCtfReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error FeeOnTransferUnsupported(address token);
    error InvalidAddress();
    error InvalidFill();
    error MarketNotOpen(bytes32 marketId);
    error OnlyExchange(address caller);
    error ResidualSettlementBalance(address asset, uint256 id, uint256 amount);
    error FeeExceedsSignedMaximum(bytes32 orderHash, uint16 feeBps, uint16 maximumBps);

    event TradingFeeCharged(
        bytes32 indexed orderHash,
        bytes32 indexed marketId,
        uint256 indexed positionId,
        bool isMaker,
        uint16 feeBps,
        uint256 grossAmount,
        uint256 feeAmount
    );

    event CollateralSplit(
        bytes32 indexed marketId,
        address indexed funder,
        address indexed collateralToken,
        bytes32 conditionId,
        uint256 amount
    );

    IMarketRegistry public immutable registry;
    address public immutable exchange;
    ProtocolFeeVault public immutable feeVault;
    PayoutVault public immutable payoutVault;
    mapping(bytes32 orderHash => uint16 fractionalBps) public feeRemainder;

    modifier onlyExchange() {
        if (msg.sender != exchange) revert OnlyExchange(msg.sender);
        _;
    }

    constructor(
        IConditionalTokens conditionalTokens_,
        IMarketRegistry registry_,
        address exchange_,
        ProtocolFeeVault feeVault_
    ) ExpectedCtfReceiver(conditionalTokens_) {
        if (
            address(registry_) == address(0) || address(registry_).code.length == 0
                || exchange_ == address(0) || exchange_.code.length == 0
        ) revert InvalidAddress();
        if (address(registry_.ctf()) != address(conditionalTokens_)) revert InvalidAddress();
        if (
            address(feeVault_) == address(0) || address(feeVault_).code.length == 0
                || address(feeVault_.conditionalTokens()) != address(conditionalTokens_)
                || address(feeVault_.authority()) != address(registry_.authority())
        ) revert InvalidAddress();
        registry = registry_;
        exchange = exchange_;
        feeVault = feeVault_;
        payoutVault = PayoutVault(IAtomicExchange(exchange_).payoutVault());
        if (address(payoutVault).code.length == 0 || payoutVault.exchange() != exchange_) {
            revert InvalidAddress();
        }
        conditionalTokens_.setApprovalForAll(address(payoutVault), true);
    }

    function settleFill(
        SettlementFill calldata fill
    ) external nonReentrant onlyExchange returns (Payout[4] memory payouts) {
        if (
            fill.buyerMaker == address(0) || fill.buyerRecipient == address(0)
                || fill.sellerMaker == address(0) || fill.sellerRecipient == address(0)
                || fill.fillQuantity == 0 || fill.executionQuote == 0
        ) revert InvalidFill();

        Market memory market = registry.getMarket(fill.marketId);
        if (
            market.state != MarketState.OPEN || block.timestamp < market.tradingOpen
                || block.timestamp >= market.tradingCutoff
        ) revert MarketNotOpen(fill.marketId);

        // Snapshot both rates before any token/recipient callbacks, even if a recipient is admin.
        (uint16 makerBps, uint16 takerBps) = feeVault.feeRates();
        uint256 buyerFee = _calculateFee(
            fill.buyOrderHash,
            fill.fillQuantity,
            fill.bidIsMaker ? makerBps : takerBps,
            fill.buyMaxFeeBps
        );
        uint256 sellerFee = _calculateFee(
            fill.sellOrderHash,
            fill.executionQuote,
            fill.bidIsMaker ? takerBps : makerBps,
            fill.sellMaxFeeBps
        );
        (payouts[0], payouts[1]) = _settleStock(fill, market, buyerFee);
        (payouts[2], payouts[3]) = _settleQuote(fill, market, sellerFee);
        // Do not emit/store zero-fee history; ERC1155 balances already cover all transfers.
        if (buyerFee != 0) {
            emit TradingFeeCharged(
                fill.buyOrderHash,
                fill.marketId,
                fill.branch == Branch.YES ? market.stockYesPositionId : market.stockNoPositionId,
                fill.bidIsMaker,
                fill.bidIsMaker ? makerBps : takerBps,
                fill.fillQuantity,
                buyerFee
            );
        }
        if (sellerFee != 0) {
            emit TradingFeeCharged(
                fill.sellOrderHash,
                fill.marketId,
                fill.branch == Branch.YES ? market.quoteYesPositionId : market.quoteNoPositionId,
                !fill.bidIsMaker,
                fill.bidIsMaker ? takerBps : makerBps,
                fill.executionQuote,
                sellerFee
            );
        }
    }

    function _settleStock(
        SettlementFill calldata fill,
        Market memory market,
        uint256 fee
    ) private returns (Payout memory active, Payout memory inactive) {
        uint256 activePosition =
            fill.branch == Branch.YES ? market.stockYesPositionId : market.stockNoPositionId;

        if (fill.sellFundingKind == FundingKind.WHOLE_COLLATERAL) {
            uint256 inactivePosition =
                fill.branch == Branch.YES ? market.stockNoPositionId : market.stockYesPositionId;
            uint256 balanceBefore = _pullWhole(IERC20(market.baseToken), fill.fillQuantity);
            _splitCollateral(
                fill.marketId,
                fill.sellerMaker,
                IERC20(market.baseToken),
                market.conditionId,
                market.stockYesPositionId,
                market.stockNoPositionId,
                fill.fillQuantity,
                balanceBefore
            );
            active = _stageClaim(fill.buyerRecipient, activePosition, fill.fillQuantity - fee);
            inactive = _stageClaim(fill.sellerMaker, inactivePosition, fill.fillQuantity);
            _assertNoClaimBalance(inactivePosition);
        } else {
            _pullClaim(activePosition, fill.fillQuantity);
            active = _stageClaim(fill.buyerRecipient, activePosition, fill.fillQuantity - fee);
        }

        _deliverFee(activePosition, fee);
        _assertNoClaimBalance(activePosition);
    }

    function _settleQuote(
        SettlementFill calldata fill,
        Market memory market,
        uint256 fee
    ) private returns (Payout memory active, Payout memory inactive) {
        uint256 activePosition =
            fill.branch == Branch.YES ? market.quoteYesPositionId : market.quoteNoPositionId;

        if (fill.buyFundingKind == FundingKind.WHOLE_COLLATERAL) {
            uint256 inactivePosition =
                fill.branch == Branch.YES ? market.quoteNoPositionId : market.quoteYesPositionId;
            uint256 balanceBefore = _pullWhole(IERC20(market.quoteToken), fill.executionQuote);
            _splitCollateral(
                fill.marketId,
                fill.buyerMaker,
                IERC20(market.quoteToken),
                market.conditionId,
                market.quoteYesPositionId,
                market.quoteNoPositionId,
                fill.executionQuote,
                balanceBefore
            );
            active = _stageClaim(fill.sellerRecipient, activePosition, fill.executionQuote - fee);
            inactive = _stageClaim(fill.buyerMaker, inactivePosition, fill.executionQuote);
            _assertNoClaimBalance(inactivePosition);
        } else {
            _pullClaim(activePosition, fill.executionQuote);
            active = _stageClaim(fill.sellerRecipient, activePosition, fill.executionQuote - fee);
        }

        _deliverFee(activePosition, fee);
        _assertNoClaimBalance(activePosition);
    }

    function _stageClaim(
        address beneficiary,
        uint256 tokenId,
        uint256 amount
    ) private returns (Payout memory payout) {
        // Carried fractional fees can consume an entire one-raw-unit fill. A zero net
        // delivery is valid and must not make this otherwise collateralized fill unfillable.
        if (amount == 0) return payout;
        payoutVault.fundClaim(tokenId, amount);
        return Payout(beneficiary, address(conditionalTokens), tokenId, amount);
    }

    function _calculateFee(
        bytes32 orderHash,
        uint256 gross,
        uint16 rate,
        uint16 maximum
    ) private returns (uint256 fee) {
        if (rate > maximum) revert FeeExceedsSignedMaximum(orderHash, rate, maximum);
        if (rate == 0) return 0;
        uint16 previous = feeRemainder[orderHash];
        uint16 remainder;
        (fee, remainder) = FeeMath.calculate(gross, rate, previous);
        if (previous != remainder) feeRemainder[orderHash] = remainder;
    }

    function _deliverFee(
        uint256 positionId,
        uint256 fee
    ) private {
        if (fee != 0) {
            conditionalTokens.safeTransferFrom(
                address(this), address(feeVault), positionId, fee, ""
            );
        }
    }

    function _pullWhole(
        IERC20 token,
        uint256 amount
    ) private returns (uint256 balanceBefore) {
        balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(exchange, address(this), amount);
        if (token.balanceOf(address(this)) - balanceBefore != amount) {
            revert FeeOnTransferUnsupported(address(token));
        }
    }

    function _pullClaim(
        uint256 positionId,
        uint256 amount
    ) private {
        _expectSingle(address(this), exchange, positionId, amount);
        conditionalTokens.safeTransferFrom(exchange, address(this), positionId, amount, "");
        _assertExpectedTransferReceived();
    }

    function _splitCollateral(
        bytes32 marketId,
        address funder,
        IERC20 collateralToken,
        bytes32 conditionId,
        uint256 yesPositionId,
        uint256 noPositionId,
        uint256 amount,
        uint256 expectedBalance
    ) private {
        collateralToken.forceApprove(address(conditionalTokens), amount);

        uint256[] memory partition = new uint256[](2);
        partition[0] = ProtocolConstants.YES_INDEX_SET;
        partition[1] = ProtocolConstants.NO_INDEX_SET;
        uint256[] memory positionIds = new uint256[](2);
        positionIds[0] = yesPositionId;
        positionIds[1] = noPositionId;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amount;
        amounts[1] = amount;

        _expectBatch(address(this), address(0), positionIds, amounts);
        conditionalTokens.splitPosition(
            collateralToken, ProtocolConstants.PARENT_COLLECTION_ID, conditionId, partition, amount
        );
        _assertExpectedTransferReceived();
        collateralToken.forceApprove(address(conditionalTokens), 0);
        uint256 actualBalance = collateralToken.balanceOf(address(this));
        if (actualBalance != expectedBalance) {
            revert ResidualSettlementBalance(address(collateralToken), 0, actualBalance);
        }
        emit CollateralSplit(marketId, funder, address(collateralToken), conditionId, amount);
    }

    function _assertNoClaimBalance(
        uint256 positionId
    ) private view {
        uint256 balance = conditionalTokens.balanceOf(address(this), positionId);
        if (balance != 0) {
            revert ResidualSettlementBalance(address(conditionalTokens), positionId, balance);
        }
    }
}
