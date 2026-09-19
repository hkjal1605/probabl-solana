import { expect, test } from "bun:test";
import type { WalletAssetBalance } from "../src/hooks/useWalletAssets";
import { headerPortfolioSummary } from "../src/lib/portfolio/summary";
import type { BranchBook, MarketView, PositionView } from "../src/types/api";

const book = (bid: number | null, ask: number | null): BranchBook => ({
  bestAskExact: ask === null ? null : String(ask),
  bestBidExact: bid === null ? null : String(bid),
  bestAsk: ask,
  bestBid: bid,
  asks: [],
  bids: [],
  depthUsd: 0,
  spread: bid !== null && ask !== null ? ask - bid : null,
});

const market = {
  id: "market",
  baseToken: "SPY",
  quoteToken: "USDC",
  baseTokenDecimals: 6,
  quoteTokenDecimals: 6,
  ticker: "SPY",
  yes: book(590, 610),
  no: book(390, 410),
  probability: { ask: null, bid: null, observedAt: null, quality: "valid", value: 0.25 },
} as MarketView;

const balance = (
  token: string,
  available: string,
  reserved: string,
  reference: number | null,
): WalletAssetBalance =>
  ({
    token,
    symbol: token,
    decimals: 6,
    reference,
    balance: {
      token,
      account: "owner",
      decimals: 6,
      canonicalBalance: "0",
      vaultAvailable: available,
      reserved,
      blockNumber: "1",
    },
  }) as WalletAssetBalance;

const position = {
  marketId: "market",
  conditionId: "market",
  stockYes: "1000000",
  stockNo: "0",
  quoteYes: "0",
  quoteNo: "10000000",
  redeemable: false,
} as PositionView;

test("header portfolio separates spendable cash and marks all owned balances", () => {
  const result = headerPortfolioSummary(
    [market],
    [balance("USDC", "100000000", "20000000", 1), balance("SPY", "2000000", "0", 500)],
    [position],
    [],
  );
  expect(result.cashAvailable).toBe(100);
  expect(result.netPortfolioValue).toBe(1727.5);
});

test("header portfolio withholds net value instead of valuing an unmarked claim at zero", () => {
  const unmarked = { ...market, yes: book(590, null) };
  const result = headerPortfolioSummary(
    [unmarked],
    [balance("USDC", "100000000", "0", 1)],
    [position],
    [],
  );
  expect(result.cashAvailable).toBe(100);
  expect(result.netPortfolioValue).toBeNull();
});
