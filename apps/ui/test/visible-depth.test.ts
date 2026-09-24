import { expect, test } from "bun:test";
import { depthLevels, visibleDepthPerSide } from "../src/lib/markets/visible-depth";

test("orderbook depth consumes only complete, symmetric rows", () => {
  expect(visibleDepthPerSide(336, 28, 28)).toBe(5);
  expect(visibleDepthPerSide(615, 28, 28)).toBe(9);
  expect(visibleDepthPerSide(616, 28, 28)).toBe(10);
});

test("orderbook depth remains safe before layout is measurable", () => {
  expect(visibleDepthPerSide(0, 28, 28)).toBe(1);
  expect(visibleDepthPerSide(Number.NaN, 28, 28)).toBe(1);
  expect(visibleDepthPerSide(336, 28, 0)).toBe(1);
});

test("issuer-filtered depth counts only matching issuers and skips emptied levels", () => {
  const level = (price: number, parts: [number, number][]) => ({
    priceExact: String(price),
    price,
    quantity: parts.reduce((sum, [, q]) => sum + q, 0),
    byBases: parts.map(([mask, quantity]) => ({ mask, quantity })),
  });
  const asks = [
    level(10, [[1, 2]]),
    level(11, [[2, 5]]),
    level(12, [
      [1, 1],
      [4, 3],
    ]),
  ];
  expect(depthLevels(asks, 5, 0b001, 0b111).map((l) => [l.price, l.cumulative])).toEqual([
    [10, 2],
    [12, 3],
  ]);
  // The visible row budget applies after filtering.
  expect(depthLevels(asks, 1, 0b100, 0b111).map((l) => l.price)).toEqual([12]);
  // Levels without a breakdown are kept whole.
  expect(depthLevels([{ priceExact: "9", price: 9, quantity: 4 }], 5, 0b010, 0b111)).toEqual([
    { priceExact: "9", price: 9, quantity: 4, cumulative: 4, mask: 0, anyIssuer: false },
  ]);
});
