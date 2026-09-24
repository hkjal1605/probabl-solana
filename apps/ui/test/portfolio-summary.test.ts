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

const leg = (collateral: number, decimals: number, multiplierValue = 1) =>
  ({
    collateral,
    bit: 1 << (collateral - 1),
    mint: `SPY${collateral}`,
    decimals,
    scale: String(10 ** (decimals - 6)),
    listingMultiplier: "4607182418800017408",
    active: true,
    ready: true,
    claimMints: { yes: "y", no: "n" },
    ...(multiplierValue === 1
      ? {}
      : {
          live: {
            multiplier: "4611686018427387904",
            multiplierValue,
            paused: false,
            vaultFrozen: false,
            tradable: false,
            halt: "corporate-action" as const,
          },
        }),
    symbol: `SPY${collateral}`,
    issuer: null,
  }) as MarketView["bases"][number];
const market = {
  id: "market",
  bases: [leg(1, 6), leg(2, 9)],
  quoteToken: "USDC",
  shareDecimals: 6,
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
  bases: [{ collateral: 1, mint: "SPY1", decimals: 6, yes: "1000000", no: "0" }],
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

test("issuer claims of different decimals and multipliers are marked as economic shares", () => {
  const multi = { ...market, bases: [leg(1, 6), leg(2, 9, 2)] } as MarketView;
  const result = headerPortfolioSummary(
    [multi],
    [],
    [
      {
        ...position,
        quoteNo: "0",
        bases: [
          { collateral: 1, mint: "SPY1", decimals: 6, yes: "1000000", no: "0" },
          // 0.5 tokens at a x2 multiplier are one economic share.
          { collateral: 2, mint: "SPY2", decimals: 9, yes: "500000000", no: "0" },
        ],
      },
    ],
    [],
  );
  expect(result.netPortfolioValue).toBe(1200);
});
