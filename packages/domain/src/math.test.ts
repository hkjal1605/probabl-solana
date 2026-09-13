import { describe, expect, test } from "bun:test";

import { mulDivDown, mulDivUp, quoteForExecution, quoteForReservation, WAD } from "./math.ts";

describe("fixed-point math", () => {
  test("rounds execution down and reservation up", () => {
    expect(mulDivDown(5n, 2n, 3n)).toBe(3n);
    expect(mulDivUp(5n, 2n, 3n)).toBe(4n);
  });

  test("quotes 1.5 stock at 260 USDG", () => {
    const quantity = (3n * WAD) / 2n;
    const price = 260n * WAD;

    expect(quoteForExecution(quantity, price)).toBe(390n * WAD);
    expect(quoteForReservation(quantity, price)).toBe(390n * WAD);
  });

  test("rejects invalid inputs", () => {
    expect(() => mulDivDown(-1n, 1n, 1n)).toThrow();
    expect(() => mulDivUp(1n, 1n, 0n)).toThrow();
  });
});
