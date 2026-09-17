import { expect, test } from "bun:test";
import { visibleDepthPerSide } from "../src/lib/markets/visible-depth";

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
