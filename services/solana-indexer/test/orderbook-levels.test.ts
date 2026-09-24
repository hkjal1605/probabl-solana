import { describe, expect, test } from "bun:test";
import { compactOrderbooks } from "../src/orderbook-levels";

describe("compact orderbooks", () => {
  test("coalesces only identical market, branch, side and price levels", () => {
    const books = compactOrderbooks(
      ["first", "second", "empty"],
      [
        { market: "first", branch: 0, side: 0, limitPriceRawX18: "100", remaining: "4", bases: 7 },
        { market: "first", branch: 0, side: 0, limitPriceRawX18: "100", remaining: "6", bases: 7 },
        { market: "first", branch: 1, side: 0, limitPriceRawX18: "100", remaining: "7", bases: 1 },
        { market: "second", branch: 0, side: 1, limitPriceRawX18: "101", remaining: "8", bases: 1 },
        { market: "unknown", branch: 0, side: 0, limitPriceRawX18: "1", remaining: "999", bases: 1 },
      ],
    );

    expect(books.first?.orders).toEqual([
      { branch: 0, side: 0, limitPriceRawX18: "100", remaining: "10", byBases: { "7": "10" } },
      { branch: 1, side: 0, limitPriceRawX18: "100", remaining: "7", byBases: { "1": "7" } },
    ]);
    expect(books.second?.orders).toEqual([
      { branch: 0, side: 1, limitPriceRawX18: "101", remaining: "8", byBases: { "1": "8" } },
    ]);
    expect(books.empty?.orders).toEqual([]);
    expect(books.unknown).toBeUndefined();
  });

  test("one level per price splits depth by issuer leg (asks) and accepted legs (bids)", () => {
    const order = (side: number, bases: number, remaining: string, price = "500") => ({
      market: "nvda",
      branch: 0,
      side,
      limitPriceRawX18: price,
      remaining,
      bases,
    });
    const books = compactOrderbooks(
      ["nvda"],
      [
        // Asks deliver exactly one issuer: NVDAx (1), NVDAon (2), NVDAr (4).
        order(1, 1, "3"),
        order(1, 2, "5"),
        order(1, 4, "7"),
        order(1, 2, "9"),
        order(1, 4, "1", "600"),
        // Bids accept a subset of listed legs.
        order(0, 7, "11", "400"),
        order(0, 3, "13", "400"),
        order(0, 7, "2", "400"),
      ],
    );
    expect(books.nvda?.orders).toEqual([
      {
        branch: 0,
        side: 1,
        limitPriceRawX18: "500",
        remaining: "24",
        byBases: { "1": "3", "2": "14", "4": "7" },
      },
      { branch: 0, side: 1, limitPriceRawX18: "600", remaining: "1", byBases: { "4": "1" } },
      {
        branch: 0,
        side: 0,
        limitPriceRawX18: "400",
        remaining: "26",
        byBases: { "7": "13", "3": "13" },
      },
    ]);
    for (const level of books.nvda!.orders)
      expect(Object.values(level.byBases).reduce((a, b) => a + BigInt(b), 0n)).toBe(
        BigInt(level.remaining),
      );
  });
});
