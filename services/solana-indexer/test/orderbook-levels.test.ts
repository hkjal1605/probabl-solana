import { describe, expect, test } from "bun:test";
import { compactOrderbooks } from "../src/orderbook-levels";

describe("compact orderbooks", () => {
  test("coalesces only identical market, branch, side and price levels", () => {
    const books = compactOrderbooks(
      ["first", "second", "empty"],
      [
        {
          market: "first",
          branch: 0,
          side: 0,
          limitPriceRawX18: "100",
          remaining: "4",
        },
        {
          market: "first",
          branch: 0,
          side: 0,
          limitPriceRawX18: "100",
          remaining: "6",
        },
        {
          market: "first",
          branch: 1,
          side: 0,
          limitPriceRawX18: "100",
          remaining: "7",
        },
        {
          market: "second",
          branch: 0,
          side: 1,
          limitPriceRawX18: "101",
          remaining: "8",
        },
        {
          market: "unknown",
          branch: 0,
          side: 0,
          limitPriceRawX18: "1",
          remaining: "999",
        },
      ],
    );

    expect(books.first?.orders).toEqual([
      { branch: 0, side: 0, limitPriceRawX18: "100", remaining: "10" },
      { branch: 1, side: 0, limitPriceRawX18: "100", remaining: "7" },
    ]);
    expect(books.second?.orders).toEqual([
      { branch: 0, side: 1, limitPriceRawX18: "101", remaining: "8" },
    ]);
    expect(books.empty?.orders).toEqual([]);
    expect(books.unknown).toBeUndefined();
  });
});
