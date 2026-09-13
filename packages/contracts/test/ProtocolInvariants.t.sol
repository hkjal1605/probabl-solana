// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    Branch,
    FundingKind,
    MarketState,
    Order,
    OrderStateData,
    OrderStatus,
    Side,
    TimeInForce
} from "../src/types/ProtocolTypes.sol";
import { ProtocolFixture } from "./ProtocolFixture.sol";
import { TestBase } from "./TestBase.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Real pinned CTF, three independently signed actors, both books and funding paths.
///      Ghost fills/cancellations are recorded from requested actions, not copied from exchange state.
contract ProtocolStatefulHandler is ProtocolFixture {
    Order[] private orders;
    bytes32[] private hashes;
    uint256[] private filled;
    bool[] private cancelled;
    uint256 private saltCounter;
    bool public immutable lifecycleEnabled;
    bool public immutable feesEnabled;
    mapping(bytes32 => uint256) private weightedFees;
    uint256[4] private expectedVaultFees;
    uint256 public successfulOpens;
    uint256 public successfulFills;
    uint256 public successfulIOCs;
    uint256 public successfulRecoveries;
    uint256 public successfulMerges;
    uint256 public successfulRedemptions;
    uint256 public finalizations;
    uint256 public actionCalls;
    uint256 private preparedYes;
    uint256 private preparedNo;
    uint256 private preparedDen;

    constructor(
        bool lifecycle_,
        bool fees_
    ) {
        lifecycleEnabled = lifecycle_;
        feesEnabled = fees_;
        super.setUp();
        if (fees_) feeVault.setFeeRates(31, 73);
        stock.mint(secondBuyer, 10_000e18);
        open(2400);
        open(3);
        matchPair(0);
        open(12);
        open(15);
        executeIOC(0);
    }

    function _actor(
        uint256 seed
    ) private view returns (address account, uint256 key) {
        uint256 actor = seed % 3;
        if (actor == 0) return (buyer, BUYER_KEY);
        if (actor == 1) return (seller, SELLER_KEY);
        return (secondBuyer, SECOND_BUYER_KEY);
    }

    function _track(
        Order memory order,
        bytes32 hash,
        uint256 executed,
        bool wasCancelled
    ) private {
        orders.push(order);
        hashes.push(hash);
        filled.push(executed);
        cancelled.push(wasCancelled);
    }

    function _canTrade() private view returns (bool) {
        return !exchange.tradingPaused() && registry.isTradingOpen(marketId);
    }

    function _live(
        uint256 index
    ) private view returns (bool) {
        Order memory order = orders[index];
        return !cancelled[index] && filled[index] < order.quantity && order.expiry > block.timestamp
            && order.nonce >= exchange.minimumNonce(order.maker);
    }

    function _fund(
        Order memory order
    ) private {
        if (order.fundingKind == FundingKind.ACTIVE_CLAIM) {
            uint256 amount = order.side == Side.BUY
                ? (uint256(order.quantity) * order.limitPriceRawX18 + WAD - 1) / WAD
                : order.quantity;
            _splitFor(order.maker, order.side == Side.BUY ? IERC20(quote) : IERC20(stock), amount);
        }
    }

    function open(
        uint256 seed
    ) public {
        ++actionCalls;
        if (!_canTrade() || orders.length >= 160) return;
        (address maker, uint256 key) = _actor(seed / 2);
        Order memory order = _order(
            maker,
            Branch((seed / 6) % 2),
            Side(seed % 2),
            FundingKind((seed / 12) % 2),
            uint128(((seed / 24) % 1000 + 1) * market.baseStep),
            uint128(100e18 + ((seed / 24000) % 20000) * market.priceTickRawX18),
            TimeInForce.GTC,
            exchange.minimumNonce(maker),
            bytes32(++saltCounter)
        );
        order.expiry = uint64(block.timestamp + (seed % 3600) + 1);
        order.maxFeeBps = feesEnabled ? 1000 : 0;
        if (order.expiry >= cutoff) order.expiry = cutoff - 1;
        if (order.expiry <= block.timestamp) return;
        _fund(order);
        _track(order, _openOrder(order, _sign(order, key)), 0, false);
        ++successfulOpens;
    }

    /// @dev Every fill is now reached through a fresh user's GTC placement, never a kernel prank.
    function matchPair(
        uint256 seed
    ) public {
        ++actionCalls;
        if (!_canTrade() || orders.length == 0 || orders.length >= 160) return;
        uint256 index = seed % orders.length;
        if (!_live(index) || orders[index].tif != TimeInForce.GTC) return;
        Order memory maker = orders[index];
        (address account, uint256 key) = _actor(seed / 3);
        if (account == maker.maker) (account, key) = _actor(seed / 3 + 1);
        uint128 available = uint128(maker.quantity - filled[index]);
        uint128 amount = uint128((seed % (available / market.baseStep) + 1) * market.baseStep);
        Order memory taker = _order(
            account,
            maker.branch,
            maker.side == Side.BUY ? Side.SELL : Side.BUY,
            FundingKind((seed / 9) % 2),
            amount + market.baseStep,
            maker.limitPriceRawX18,
            TimeInForce.GTC,
            exchange.minimumNonce(account),
            bytes32(++saltCounter)
        );
        taker.maxFeeBps = feesEnabled ? 1000 : 0;
        _fund(taker);
        Order[] memory makers = new Order[](1);
        makers[0] = maker;
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = amount;
        uint128[] memory remaining = new uint128[](1);
        remaining[0] = available;
        uint256 stockId =
            maker.branch == Branch.YES ? market.stockYesPositionId : market.stockNoPositionId;
        uint256 quoteId =
            maker.branch == Branch.YES ? market.quoteYesPositionId : market.quoteNoPositionId;
        address stockRecipient = maker.side == Side.BUY ? maker.recipient : taker.recipient;
        address quoteRecipient = maker.side == Side.SELL ? maker.recipient : taker.recipient;
        uint256 stockBefore = ctf.balanceOf(stockRecipient, stockId);
        uint256 quoteBefore = ctf.balanceOf(quoteRecipient, quoteId);
        bytes memory signature = _sign(taker, key);
        vm.prank(account);
        bytes32 hash = atomicRouter.placeAndMatch(
            taker,
            signature,
            makers,
            amounts,
            remaining,
            taker.expiry < block.timestamp + 60 ? taker.expiry : uint64(block.timestamp + 60)
        );
        uint256 executionQuote = uint256(amount) * maker.limitPriceRawX18 / WAD;
        uint256 makerFee = _recordFee(
            maker, hashes[index], maker.side == Side.BUY ? amount : executionQuote, true
        );
        uint256 takerFee =
            _recordFee(taker, hash, taker.side == Side.BUY ? amount : executionQuote, false);
        filled[index] += amount;
        _track(taker, hash, amount, false);
        assertEq(
            ctf.balanceOf(stockRecipient, stockId),
            stockBefore + amount - (maker.side == Side.BUY ? makerFee : takerFee),
            "atomic stock delivery"
        );
        assertEq(
            ctf.balanceOf(quoteRecipient, quoteId),
            quoteBefore + executionQuote - (maker.side == Side.SELL ? makerFee : takerFee),
            "atomic quote delivery"
        );
        ++successfulFills;
    }

    function executeIOC(
        uint256 seed
    ) public {
        ++actionCalls;
        if (!_canTrade() || orders.length == 0 || orders.length >= 160) return;
        uint256 index = seed % orders.length;
        if (!_live(index) || orders[index].tif != TimeInForce.GTC) return;
        Order memory maker = orders[index];
        (address account, uint256 key) = _actor(seed / 3);
        if (account == maker.maker) (account, key) = _actor(seed / 3 + 1);
        uint128 amount = uint128(
            (orders[index].quantity - filled[index]) / market.baseStep > 1
                ? market.baseStep * 2
                : market.baseStep
        );
        Order memory taker = _order(
            account,
            maker.branch,
            maker.side == Side.BUY ? Side.SELL : Side.BUY,
            FundingKind((seed / 9) % 2),
            amount + market.baseStep,
            maker.limitPriceRawX18,
            TimeInForce.IOC,
            exchange.minimumNonce(account),
            bytes32(++saltCounter)
        );
        taker.maxFeeBps = feesEnabled ? 1000 : 0;
        _fund(taker);
        Order[] memory makers = new Order[](1);
        makers[0] = maker;
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = amount;
        uint128[] memory quotedRemaining = new uint128[](1);
        quotedRemaining[0] = uint128(orders[index].quantity - filled[index]);
        bytes memory signature = _sign(taker, key);
        vm.prank(taker.maker);
        bytes32 hash = atomicRouter.placeAndMatch(
            taker,
            signature,
            makers,
            amounts,
            quotedRemaining,
            taker.expiry < block.timestamp + 60 ? taker.expiry : uint64(block.timestamp + 60)
        );
        uint256 executionQuote = uint256(amount) * maker.limitPriceRawX18 / WAD;
        _recordFee(maker, hashes[index], maker.side == Side.BUY ? amount : executionQuote, true);
        _recordFee(taker, hash, taker.side == Side.BUY ? amount : executionQuote, false);
        filled[index] += amount;
        _track(taker, hash, amount, true);
        ++successfulIOCs;
    }

    /// @dev Independent ghost arithmetic is safe here: bounded test notionals * <=1000 bps.
    function _recordFee(
        Order memory order,
        bytes32 hash,
        uint256 gross,
        bool isMaker
    ) private returns (uint256 fee) {
        uint256 rate = isMaker ? feeVault.makerFeeBps() : feeVault.takerFeeBps();
        uint256 previous = weightedFees[hash];
        weightedFees[hash] += gross * rate;
        fee = weightedFees[hash] / 10000 - previous / 10000;
        expectedVaultFees[(order.side == Side.BUY ? 0 : 2) + uint256(order.branch)] += fee;
        assertEq(settlement.feeRemainder(hash), weightedFees[hash] % 10000, "ghost fee carry");
    }

    function changeFees(
        uint256 seed
    ) external {
        if (!feesEnabled) return;
        // Both remainders are at most 1,000, strictly inside uint16.
        // forge-lint: disable-next-line(unsafe-typecast)
        feeVault.setFeeRates(uint16(seed % 1001), uint16((seed / 1001) % 1001));
    }

    function claimFees(
        uint256 seed
    ) external {
        if (!feesEnabled) return;
        uint256 index = seed % 4;
        uint256 balance = expectedVaultFees[index];
        if (balance == 0) return;
        uint256[4] memory positions = [
            market.stockYesPositionId,
            market.stockNoPositionId,
            market.quoteYesPositionId,
            market.quoteNoPositionId
        ];
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = positions[index];
        amounts[0] = seed % balance + 1;
        (address recipient,) = _actor(seed / 4);
        feeVault.claimFees(recipient, ids, amounts);
        expectedVaultFees[index] -= amounts[0];
    }

    function redeemFeeClaims(
        uint256 seed
    ) external {
        if (!feesEnabled || ctf.payoutDenominator(market.conditionId) == 0) return;
        uint256 index = seed % 4;
        uint256[] memory sets = new uint256[](1);
        sets[0] = index % 2 == 0 ? 1 : 2;
        (address recipient,) = _actor(seed / 4);
        feeVault.redeemFees(
            index < 2 ? IERC20(stock) : IERC20(quote), market.conditionId, sets, recipient
        );
        expectedVaultFees[index] = 0;
    }

    function cancel(
        uint256 seed
    ) external {
        ++actionCalls;
        if (orders.length == 0) return;
        uint256 index = seed % orders.length;
        if (cancelled[index] || filled[index] == orders[index].quantity) return;
        vm.prank(orders[index].maker);
        exchange.cancelOrder(hashes[index]);
        cancelled[index] = true;
        ++successfulRecoveries;
    }

    function invalidate(
        uint256 seed
    ) external {
        ++actionCalls;
        (address account,) = _actor(seed);
        uint64 next = exchange.minimumNonce(account) + 1;
        vm.prank(account);
        exchange.cancelUpTo(next);
    }

    function release(
        uint256 seed
    ) external {
        ++actionCalls;
        if (orders.length == 0) return;
        uint256 index = seed % orders.length;
        if (cancelled[index] || filled[index] == orders[index].quantity) return;
        Order memory order = orders[index];
        if (order.expiry <= block.timestamp) {
            exchange.releaseExpiredOrder(hashes[index]);
        } else if (order.nonce < exchange.minimumNonce(order.maker)) {
            exchange.releaseInvalidatedOrder(hashes[index]);
        } else if (registry.marketState(marketId) != MarketState.OPEN) {
            exchange.releaseClosedMarketOrder(hashes[index]);
        } else {
            return;
        }
        cancelled[index] = true;
        ++successfulRecoveries;
    }

    function pause(
        bool paused
    ) external {
        ++actionCalls;
        if (exchange.tradingPaused() != paused) {
            exchange.setTradingPaused(paused, keccak256("STATEFUL_PAUSE"));
        }
    }

    function elapse(
        uint256 seed
    ) external {
        ++actionCalls;
        vm.warp(block.timestamp + seed % 121);
    }

    function split(
        uint256 seed
    ) external {
        ++actionCalls;
        (address account,) = _actor(seed);
        IERC20 token = seed % 2 == 0 ? IERC20(stock) : IERC20(quote);
        _splitFor(account, token, seed % 1e18 + 1);
    }

    function merge(
        uint256 seed
    ) external {
        ++actionCalls;
        (address account,) = _actor(seed);
        bool useStock = seed % 2 == 0;
        uint256 yesBalance = ctf.balanceOf(
            account, useStock ? market.stockYesPositionId : market.quoteYesPositionId
        );
        uint256 noBalance =
            ctf.balanceOf(account, useStock ? market.stockNoPositionId : market.quoteNoPositionId);
        uint256 available = yesBalance < noBalance ? yesBalance : noBalance;
        if (available == 0) return;
        uint256 amount = seed % available + 1;
        IERC20 token = useStock ? IERC20(stock) : IERC20(quote);
        uint256 beforeBalance = token.balanceOf(account);
        vm.prank(account);
        positionRouter.mergeForUser(token, market.conditionId, amount, account);
        assertEq(token.balanceOf(account), beforeBalance + amount, "merge conserved collateral");
        ++successfulMerges;
    }

    function lifecycle(
        uint256 seed
    ) external {
        ++actionCalls;
        if (!lifecycleEnabled || actionCalls < 24) return;
        MarketState state = registry.marketState(marketId);
        if (state == MarketState.OPEN) {
            if (seed % 2 == 0) {
                registry.freezeMarket(marketId, keccak256("STATEFUL_FREEZE"));
            } else {
                vm.warp(cutoff);
                registry.freezeAtCutoff(marketId);
            }
        } else if (state == MarketState.FROZEN) {
            preparedYes = seed % 3 == 1 ? 0 : 1;
            preparedNo = seed % 3 == 0 ? 0 : 1;
            preparedDen = seed % 3 == 2 ? 2 : 1;
            registry.beginResolution(
                marketId,
                resolutionController.hashResolution(
                    marketId,
                    preparedYes,
                    preparedNo,
                    preparedDen,
                    keccak256("STATEFUL_EVIDENCE"),
                    "ipfs://stateful-evidence"
                )
            );
        } else if (state == MarketState.AWAITING_RESOLUTION) {
            resolutionController.resolveMarket(
                marketId,
                preparedYes,
                preparedNo,
                preparedDen,
                keccak256("STATEFUL_EVIDENCE"),
                "ipfs://stateful-evidence"
            );
            ++finalizations;
        } else if (state == MarketState.REDEEMABLE) {
            registry.archiveMarket(marketId, keccak256("STATEFUL_ARCHIVE"));
        }
    }

    function redeem(
        uint256 seed
    ) external {
        ++actionCalls;
        uint256 denominator = ctf.payoutDenominator(market.conditionId);
        if (denominator == 0) return;
        (address account,) = _actor(seed);
        bool useStock = seed % 2 == 0;
        bool yes = seed % 4 < 2;
        uint256 id = useStock
            ? (yes ? market.stockYesPositionId : market.stockNoPositionId)
            : (yes ? market.quoteYesPositionId : market.quoteNoPositionId);
        uint256 available = ctf.balanceOf(account, id);
        if (available == 0) return;
        uint256[] memory sets = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        sets[0] = yes ? 1 : 2;
        amounts[0] = seed % available + 1;
        IERC20 token = useStock ? IERC20(stock) : IERC20(quote);
        uint256 beforeBalance = token.balanceOf(account);
        vm.prank(account);
        positionRouter.redeemForUser(token, market.conditionId, sets, amounts, account);
        uint256 expected =
            amounts[0] * ctf.payoutNumerators(market.conditionId, yes ? 0 : 1) / denominator;
        assertEq(token.balanceOf(account), beforeBalance + expected, "exact redemption payout");
        ++successfulRedemptions;
    }

    function replay(
        uint256 seed
    ) external {
        ++actionCalls;
        if (orders.length == 0) return;
        uint256 index = seed % orders.length;
        Order memory order = orders[index];
        uint256 key = order.maker == buyer
            ? BUYER_KEY
            : order.maker == seller ? SELLER_KEY : SECOND_BUYER_KEY;
        bytes32 beforeState = keccak256(abi.encode(exchange.getOrderState(hashes[index])));
        bytes memory signature = _sign(order, key);
        vm.prank(order.maker);
        try atomicRouter.placeAndMatch(
            order,
            signature,
            new Order[](0),
            new uint128[](0),
            new uint128[](0),
            uint64(block.timestamp + 60)
        ) {
            revert AssertionFailed("duplicate order reopened");
        } catch { }
        assertEq(
            keccak256(abi.encode(exchange.getOrderState(hashes[index]))),
            beforeState,
            "replay preserved state"
        );
    }

    function recoverAll() external {
        for (uint256 i; i < orders.length; ++i) {
            if (cancelled[i] || filled[i] == orders[i].quantity) continue;
            vm.prank(orders[i].maker);
            exchange.cancelOrder(hashes[i]);
            cancelled[i] = true;
            ++successfulRecoveries;
        }
        assertEq(exchange.marketOpenNotional(marketId), 0, "all makers can exit remaining escrow");
    }

    function assertAccounting() external view {
        uint256 openTotal;
        uint256 wholeStock;
        uint256 wholeQuote;
        uint256[4] memory claims;
        uint256[3] memory wallets;
        for (uint256 i; i < orders.length; ++i) {
            Order memory order = orders[i];
            OrderStateData memory state = exchange.getOrderState(hashes[i]);
            assertTrue(filled[i] <= order.quantity, "no overfill");
            uint256 remaining = cancelled[i] ? 0 : order.quantity - filled[i];
            assertEq(state.remaining, remaining, "ghost remaining quantity");
            OrderStatus expectedStatus = cancelled[i]
                ? OrderStatus.CANCELLED
                : remaining == 0 ? OrderStatus.FILLED : OrderStatus.OPEN;
            assertEq(uint256(state.status), uint256(expectedStatus), "terminal state monotonicity");
            uint256 notional = (remaining * order.limitPriceRawX18 + WAD - 1) / WAD;
            uint256 reservation = order.side == Side.BUY ? notional : remaining;
            assertEq(state.openNotional, notional, "per-order open notional");
            assertEq(state.reserved, reservation, "per-order funding");
            openTotal += notional;
            wallets[order.maker == buyer ? 0 : order.maker == seller ? 1 : 2] += notional;
            if (order.fundingKind == FundingKind.WHOLE_COLLATERAL) {
                if (order.side == Side.BUY) wholeQuote += reservation;
                else wholeStock += reservation;
            } else {
                claims[(order.side == Side.BUY ? 2 : 0) + uint256(order.branch)] += reservation;
            }
        }
        assertEq(
            exchange.marketOpenNotional(marketId), openTotal, "market counter equals live orders"
        );
        assertTrue(openTotal <= market.maxMarketOpenNotional, "market cap");
        for (uint256 i; i < 3; ++i) {
            (address account,) = _actor(i);
            assertEq(
                exchange.walletOpenNotional(marketId, account),
                wallets[i],
                "wallet counter equals live orders"
            );
            assertTrue(wallets[i] <= market.maxWalletOpenNotional, "wallet cap");
        }
        assertEq(stock.balanceOf(address(exchange)), wholeStock, "exact stock escrow");
        assertEq(quote.balanceOf(address(exchange)), wholeQuote, "exact quote escrow");
        uint256[4] memory ids = [
            market.stockYesPositionId,
            market.stockNoPositionId,
            market.quoteYesPositionId,
            market.quoteNoPositionId
        ];
        uint256[4] memory totalClaims;
        for (uint256 i; i < 4; ++i) {
            assertEq(ctf.balanceOf(address(exchange), ids[i]), claims[i], "exact claim escrow");
            assertEq(ctf.balanceOf(address(settlement), ids[i]), 0, "no settlement claim residue");
            assertEq(ctf.balanceOf(address(positionRouter), ids[i]), 0, "no router claim residue");
            assertEq(
                ctf.balanceOf(address(feeVault), ids[i]),
                expectedVaultFees[i],
                "ghost vault fee balance"
            );
            totalClaims[i] = claims[i] + ctf.balanceOf(buyer, ids[i])
                + ctf.balanceOf(seller, ids[i]) + ctf.balanceOf(secondBuyer, ids[i])
                + expectedVaultFees[i];
        }
        uint256 denominator = ctf.payoutDenominator(market.conditionId);
        if (denominator == 0) {
            assertEq(
                totalClaims[0], stock.balanceOf(address(ctf)), "all YES stock claims fully backed"
            );
            assertEq(
                totalClaims[1], stock.balanceOf(address(ctf)), "all NO stock claims fully backed"
            );
            assertEq(
                totalClaims[2], quote.balanceOf(address(ctf)), "all YES quote claims fully backed"
            );
            assertEq(
                totalClaims[3], quote.balanceOf(address(ctf)), "all NO quote claims fully backed"
            );
        } else {
            uint256 yes = ctf.payoutNumerators(market.conditionId, 0);
            uint256 no = ctf.payoutNumerators(market.conditionId, 1);
            assertTrue(
                (totalClaims[0] * yes + totalClaims[1] * no) / denominator
                    <= stock.balanceOf(address(ctf)),
                "remaining stock claims cannot overdraw CTF"
            );
            assertTrue(
                (totalClaims[2] * yes + totalClaims[3] * no) / denominator
                    <= quote.balanceOf(address(ctf)),
                "remaining quote claims cannot overdraw CTF"
            );
        }
        assertEq(stock.balanceOf(address(settlement)), 0, "no settlement stock residue");
        assertEq(quote.balanceOf(address(settlement)), 0, "no settlement quote residue");
        assertEq(stock.balanceOf(address(positionRouter)), 0, "no router stock residue");
        assertEq(quote.balanceOf(address(positionRouter)), 0, "no router quote residue");
        assertEq(
            stock.totalSupply(),
            stock.balanceOf(buyer) + stock.balanceOf(seller) + stock.balanceOf(secondBuyer)
                + wholeStock + stock.balanceOf(address(ctf)),
            "stock conservation"
        );
        assertEq(
            quote.totalSupply(),
            quote.balanceOf(buyer) + quote.balanceOf(seller) + quote.balanceOf(secondBuyer)
                + wholeQuote + quote.balanceOf(address(ctf)),
            "quote conservation"
        );
        assertTrue(finalizations <= 1, "one-time finalization");
        if (finalizations == 1) {
            assertTrue(resolutionController.resolved(marketId), "controller finalized");
            assertEq(
                ctf.payoutDenominator(market.conditionId), preparedDen, "immutable denominator"
            );
            assertEq(
                ctf.payoutNumerators(market.conditionId, 0), preparedYes, "immutable YES payout"
            );
            assertEq(ctf.payoutNumerators(market.conditionId, 1), preparedNo, "immutable NO payout");
            assertEq(registry.resolutionCommitments(marketId), bytes32(0), "approval consumed once");
        }
    }
}

abstract contract InvariantTargets is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    ProtocolStatefulHandler internal handler;

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](16);
        selectors[0] = handler.open.selector;
        selectors[1] = handler.matchPair.selector;
        selectors[2] = handler.executeIOC.selector;
        selectors[3] = handler.cancel.selector;
        selectors[4] = handler.invalidate.selector;
        selectors[5] = handler.release.selector;
        selectors[6] = handler.pause.selector;
        selectors[7] = handler.elapse.selector;
        selectors[8] = handler.split.selector;
        selectors[9] = handler.merge.selector;
        selectors[10] = handler.lifecycle.selector;
        selectors[11] = handler.redeem.selector;
        selectors[12] = handler.replay.selector;
        selectors[13] = handler.changeFees.selector;
        selectors[14] = handler.claimFees.selector;
        selectors[15] = handler.redeemFeeClaims.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantEscrowCountersConservationAndFinality() public view {
        handler.assertAccounting();
    }

    function afterInvariant() public {
        handler.recoverAll();
        handler.assertAccounting();
    }
}

contract TradingInvariantsTest is InvariantTargets {
    function setUp() public {
        handler = new ProtocolStatefulHandler(false, false);
    }
}

contract LifecycleInvariantsTest is InvariantTargets {
    function setUp() public {
        handler = new ProtocolStatefulHandler(true, false);
    }
}

/// @dev Proves that the randomized handler can actually reach each economic lifecycle action.
contract StatefulReachabilityTest is TestBase {
    function testHandlerExecutesTradingRecoveryMergeResolutionAndRedemption() public {
        ProtocolStatefulHandler exercised = new ProtocolStatefulHandler(true, false);
        assertTrue(exercised.successfulOpens() >= 4, "seeded real opens");
        assertTrue(exercised.successfulFills() > 0, "seeded real partial fill");
        assertTrue(exercised.successfulIOCs() > 0, "seeded real IOC with remainder");
        exercised.assertAccounting();
        exercised.cancel(0);
        exercised.invalidate(0);
        exercised.release(3);
        assertTrue(
            exercised.successfulRecoveries() >= 2, "real cancellation and invalidated release"
        );
        exercised.split(6);
        exercised.merge(6);
        assertTrue(exercised.successfulMerges() > 0, "real complete-set merge");
        exercised.split(8);
        for (uint256 i; i < 24; ++i) {
            exercised.pause(false);
        }
        exercised.lifecycle(0);
        exercised.lifecycle(2);
        exercised.lifecycle(0);
        assertEq(exercised.finalizations(), 1, "real committed resolution");
        exercised.redeem(8);
        assertTrue(
            exercised.successfulRedemptions() > 0, "real positive invalid-outcome redemption"
        );
        exercised.lifecycle(0);
        exercised.replay(0);
        exercised.recoverAll();
        exercised.assertAccounting();
    }
}

contract FeeTradingInvariantsTest is InvariantTargets {
    function setUp() public {
        handler = new ProtocolStatefulHandler(false, true);
    }
}

contract FeeLifecycleInvariantsTest is InvariantTargets {
    function setUp() public {
        handler = new ProtocolStatefulHandler(true, true);
    }
}
