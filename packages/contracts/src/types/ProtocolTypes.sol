// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

enum Branch {
    YES,
    NO
}

enum Side {
    BUY,
    SELL
}

enum FundingKind {
    WHOLE_COLLATERAL,
    ACTIVE_CLAIM
}

enum TimeInForce {
    GTC,
    IOC
}

enum MarketState {
    NONE,
    SCHEDULED,
    OPEN,
    FROZEN,
    AWAITING_RESOLUTION,
    RESOLVED,
    REDEEMABLE,
    ARCHIVED
}

enum OrderStatus {
    NONE,
    OPEN,
    FILLED,
    CANCELLED
}

struct MarketConfig {
    address baseToken;
    address quoteToken;
    bytes32 polymarketConditionId;
    uint256 polymarketYesIndex;
    uint256 polymarketNoIndex;
    uint64 tradingOpen;
    uint64 tradingCutoff;
    bytes32 rulesHash;
    bytes32 metadataHash;
    uint128 priceTickRawX18;
    uint128 baseStep;
    uint128 minNotional;
    uint128 maxOrderQuantity;
    uint128 maxOrderNotional;
    // These caps measure live open orders only, not filled exposure or total CTF collateral.
    uint128 maxWalletOpenNotional;
    uint128 maxMarketOpenNotional;
}

struct Market {
    address baseToken;
    address quoteToken;
    bytes32 localQuestionId;
    bytes32 conditionId;
    bytes32 polymarketConditionId;
    bytes32 rulesHash;
    bytes32 metadataHash;
    uint256 polymarketYesIndex;
    uint256 polymarketNoIndex;
    uint256 stockYesPositionId;
    uint256 stockNoPositionId;
    uint256 quoteYesPositionId;
    uint256 quoteNoPositionId;
    uint64 tradingOpen;
    uint64 tradingCutoff;
    uint128 priceTickRawX18;
    uint128 baseStep;
    uint128 minNotional;
    uint128 maxOrderQuantity;
    uint128 maxOrderNotional;
    // These caps measure live open orders only, not filled exposure or total CTF collateral.
    uint128 maxWalletOpenNotional;
    uint128 maxMarketOpenNotional;
    MarketState state;
}

struct Order {
    address maker;
    address recipient;
    bytes32 marketId;
    Branch branch;
    Side side;
    FundingKind fundingKind;
    uint128 quantity;
    uint128 limitPriceRawX18;
    TimeInForce tif;
    uint64 expiry;
    uint64 nonce;
    bytes32 salt;
    // Applies to either liquidity role; rates above this cap cannot fill the order.
    uint16 maxFeeBps;
}

struct OrderStateData {
    address maker;
    bytes32 marketId;
    uint256 reserved;
    uint256 openNotional;
    uint128 remaining;
    uint128 limitPriceRawX18;
    uint64 sequence;
    uint64 expiry;
    uint64 nonce;
    Branch branch;
    Side side;
    FundingKind fundingKind;
    OrderStatus status;
}

struct SettlementFill {
    bytes32 marketId;
    address buyerMaker;
    address buyerRecipient;
    address sellerMaker;
    address sellerRecipient;
    uint256 fillQuantity;
    uint256 executionQuote;
    Branch branch;
    FundingKind buyFundingKind;
    FundingKind sellFundingKind;
    bytes32 buyOrderHash;
    bytes32 sellOrderHash;
    uint16 buyMaxFeeBps;
    uint16 sellMaxFeeBps;
    bool bidIsMaker;
}

/// @notice Exact-asset delivery, staged until every fill has finished accounting.
/// @dev asset == conditionalTokens identifies an ERC1155 claim; other assets are ERC20
///      collateral with tokenId zero. Zero amounts are unused slots, never liabilities.
struct Payout {
    address beneficiary;
    address asset;
    uint256 tokenId;
    uint256 amount;
}

/// @notice Opt-in reviewed-book guard used by the first-party API/UI.
struct ExecutionGuard {
    uint64 nextSequence;
    uint16 makerFeeBps;
    uint16 takerFeeBps;
}
