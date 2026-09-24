import { beforeEach, expect, test } from "bun:test";
import "./harness";

const engine = await import("../src/protocol/engine");
const { QUOTE_MINT } = await import("../src/protocol/config");

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing value under test.");
  return value;
}

const balance = (mint: string) => {
  const row = required(engine.walletSnapshot().balances[mint]);
  return {
    external: BigInt(row.canonicalBalance),
    vault: BigInt(row.vaultAvailable),
    reserved: BigInt(row.reserved),
  };
};
/** Every unit of a token sits in exactly one place: the wallet, the vault, or escrow. */
const custody = (mint: string) => {
  const row = balance(mint);
  return row.external + row.vault + row.reserved;
};

const openMarket = () => {
  const market = engine
    .listMarkets()
    .find((row) => row.lifecycle === "open" && row.ticker === "NVDA");
  return required(market);
};

beforeEach(() => {
  engine.resetWallet();
  engine.start();
  engine.connect();
  engine.deposit(QUOTE_MINT, 10_000_000_000n);
  engine.approveTrading("5000", "50000");
});

test("a filled market order never leaves stranded escrow", () => {
  const market = openMarket();
  const limit =
    BigInt(Math.round(Number(required(market.yes.bestAskExact)) * 100 + 200)) * 10n ** 16n;
  engine.submitOrder({
    marketId: market.id,
    branch: "YES",
    side: "buy",
    tif: "ioc",
    funding: "whole",
    quantityRaw: "500000",
    limitPriceRawX18: limit.toString(),
    maxFeeBps: 0,
  });
  const order = required(engine.listOrders().orders[0]);
  expect(order.status).toBe("filled");
  expect(BigInt(order.reserved)).toBe(0n);
  expect(balance(QUOTE_MINT).reserved).toBe(0n);
  const position = required(
    engine.walletSnapshot().positions.find((row) => row.marketId === market.id),
  );
  // Quote spent equals the complementary cash claim minted by the fill.
  const spent = 10_000_000_000n - balance(QUOTE_MINT).vault;
  expect(BigInt(position.quoteNo)).toBe(spent);
  expect(BigInt(position.stockYes)).toBe(BigInt(order.filled));
});

test("cancelling a resting order returns the whole reservation", () => {
  const market = openMarket();
  const before = balance(QUOTE_MINT).vault;
  const limit =
    BigInt(Math.round(Number(required(market.yes.bestBidExact)) * 100 - 1000)) * 10n ** 16n;
  engine.submitOrder({
    marketId: market.id,
    branch: "YES",
    side: "buy",
    tif: "gtc",
    funding: "whole",
    quantityRaw: "1000000",
    limitPriceRawX18: limit.toString(),
    maxFeeBps: 0,
  });
  const order = required(engine.listOrders().orders[0]);
  expect(order.status).toBe("open");
  expect(balance(QUOTE_MINT).reserved).toBe(BigInt(order.reserved));
  expect(balance(QUOTE_MINT).vault).toBe(before - BigInt(order.reserved));
  engine.cancelOrder(order.id);
  expect(balance(QUOTE_MINT).vault).toBe(before);
  expect(balance(QUOTE_MINT).reserved).toBe(0n);
});

test("deposits, withdrawals, splits and merges conserve the token supply", () => {
  const market = openMarket();
  const supply = custody(market.baseToken);
  engine.deposit(market.baseToken, 20_000_000n);
  expect(custody(market.baseToken)).toBe(supply);
  engine.claimAction({
    kind: "Split",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 8_000_000n,
  });
  // Split moves collateral into paired claims, so custody drops by exactly that amount.
  expect(custody(market.baseToken)).toBe(supply - 8_000_000n);
  const split = required(
    engine.walletSnapshot().positions.find((row) => row.marketId === market.id),
  );
  expect(BigInt(split.stockYes)).toBe(8_000_000n);
  expect(BigInt(split.stockNo)).toBe(8_000_000n);
  engine.claimAction({
    kind: "Merge",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 8_000_000n,
  });
  expect(custody(market.baseToken)).toBe(supply);
  engine.withdraw(market.baseToken, 20_000_000n);
  expect(custody(market.baseToken)).toBe(supply);
  expect(balance(market.baseToken).vault).toBe(0n);
});

test("claim-funded sells spend claims and never mint a complementary branch", () => {
  const market = openMarket();
  engine.deposit(market.baseToken, 10_000_000n);
  engine.claimAction({
    kind: "Split",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 10_000_000n,
  });
  const before = required(
    engine.walletSnapshot().positions.find((row) => row.marketId === market.id),
  );
  const limit =
    BigInt(Math.round(Number(required(market.yes.bestBidExact)) * 100 - 200)) * 10n ** 16n;
  engine.submitOrder({
    marketId: market.id,
    branch: "YES",
    side: "sell",
    tif: "ioc",
    funding: "claim",
    quantityRaw: "2000000",
    limitPriceRawX18: limit.toString(),
    maxFeeBps: 0,
  });
  const order = required(engine.listOrders().orders[0]);
  const after = required(
    engine.walletSnapshot().positions.find((row) => row.marketId === market.id),
  );
  expect(BigInt(order.filled)).toBeGreaterThan(0n);
  expect(BigInt(before.stockYes) - BigInt(after.stockYes)).toBe(BigInt(order.filled));
  expect(BigInt(after.quoteYes)).toBeGreaterThan(0n);
  // Claim funding never mints the complementary branch a whole-token sell would.
  expect(BigInt(after.stockNo)).toBe(BigInt(before.stockNo));
});

test("an order beyond the approved per-order limit is refused", () => {
  const market = openMarket();
  const limit = BigInt(Math.round(Number(required(market.yes.bestAskExact)) * 100)) * 10n ** 16n;
  expect(() =>
    engine.submitOrder({
      marketId: market.id,
      branch: "YES",
      side: "buy",
      tif: "ioc",
      funding: "whole",
      quantityRaw: "40000000",
      limitPriceRawX18: limit.toString(),
      maxFeeBps: 0,
    }),
  ).toThrow("per-order limit");
});

test("a settled market pays winning claims and burns losing ones", () => {
  const market = required(engine.listMarkets().find((row) => row.lifecycle === "redeemable"));
  engine.deposit(market.baseToken, 6_000_000n);
  engine.claimAction({
    kind: "Split",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 6_000_000n,
  });
  const before = balance(market.baseToken).vault;
  engine.claimAction({
    kind: "Redeem",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 0n,
  });
  expect(balance(market.baseToken).vault - before).toBe(6_000_000n);
  const position = required(
    engine.walletSnapshot().positions.find((row) => row.marketId === market.id),
  );
  expect(BigInt(position.stockYes)).toBe(0n);
  expect(BigInt(position.stockNo)).toBe(0n);
});
