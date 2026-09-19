import { describe, expect, test } from "bun:test";

import { PolymarketYesBook, type ProbabilityQuality } from "../src/index.ts";
import { bookSnapshot } from "./helpers.ts";

const conditionId = `0x${"12".repeat(32)}` as const;
const now = 1_767_225_600_100n;

const createBook = (standardNotionalX6 = 100_000_000n) =>
  new PolymarketYesBook(conditionId, "111", {
    staleAfterMs: 30_000n,
    standardNotionalX6,
  });

describe("Polymarket YES order book", () => {
  test("malformed snapshots and multi-leg deltas never partially mutate the book", () => {
    const book = createBook();
    book.applySnapshot(bookSnapshot(), now);
    const before = book.tick(now);
    expect(() =>
      book.applySnapshot(
        bookSnapshot({
          bids: [{ price: "0.49", size: "400" }],
          asks: [{ price: "bad", size: "400" }],
        }),
        now,
      ),
    ).toThrow();
    expect(book.tick(now)).toEqual(before);
    expect(() =>
      book.applyWebSocket(
        {
          event_type: "price_change",
          market: conditionId,
          timestamp: String(now),
          price_changes: [
            { asset_id: "111", price: "0.49", side: "BUY", size: "400" },
            { asset_id: "111", price: "0.50", side: "invalid", size: "400" },
          ],
        },
        now,
      ),
    ).toThrow();
    expect(book.tick(now)).toEqual(before);
  });
  test("bootstraps, applies deltas, deduplicates, and detects a sequence gap", () => {
    const book = createBook();
    const snapshot = bookSnapshot({ sequence: "10" });
    expect(book.applySnapshot(snapshot, now).tick).toMatchObject({
      bestAskX6: "520000",
      bestBidX6: "480000",
      midpointX6: "500000",
      quality: "valid",
      spreadX6: "40000",
    });
    expect(book.applySnapshot(snapshot, now).duplicate).toBe(true);

    const update = {
      event_type: "price_change",
      market: conditionId,
      price_changes: [{ asset_id: "111", price: "0.49", side: "BUY", size: "400" }],
      sequence: "11",
      timestamp: "1767225600100",
    };
    expect(book.applyWebSocket(update, now).tick?.bestBidX6).toBe("490000");
    expect(book.applyWebSocket(update, now).duplicate).toBe(true);
    expect(
      book.applyWebSocket({ ...update, sequence: "13", timestamp: "1767225600200" }, now),
    ).toMatchObject({ applied: false, requiresSnapshot: true });
  });

  test("uses REST receipt time for freshness while preserving source ordering", () => {
    const book = createBook();
    const oldSource = bookSnapshot({ timestamp: String(now - 86_400_000n) });
    expect(book.applySnapshot(oldSource, now).tick).toMatchObject({
      observedAtMs: now.toString(),
      quality: "valid",
    });
    expect(book.applySnapshot(oldSource, now + 20_000n).tick).toMatchObject({
      observedAtMs: (now + 20_000n).toString(),
      quality: "valid",
    });
    expect(
      book.applyWebSocket(
        {
          event_type: "price_change",
          market: conditionId,
          price_changes: [{ asset_id: "111", price: "0.49", side: "BUY", size: "400" }],
          timestamp: String(now - 86_400_001n),
        },
        now + 20_000n,
      ),
    ).toMatchObject({ applied: false, requiresSnapshot: true });
  });

  test("withholds midpoint for empty, one-sided, crossed, stale, low-depth, and disconnected books", () => {
    const cases: Array<{
      asks: Array<{ price: string; size: string }>;
      bids: Array<{ price: string; size: string }>;
      quality: ProbabilityQuality;
    }> = [
      { asks: [], bids: [], quality: "empty" },
      { asks: [], bids: [{ price: "0.48", size: "500" }], quality: "one-sided" },
      {
        asks: [{ price: "0.48", size: "500" }],
        bids: [{ price: "0.49", size: "500" }],
        quality: "crossed",
      },
      {
        asks: [{ price: "0.52", size: "1" }],
        bids: [{ price: "0.48", size: "1" }],
        quality: "low-depth",
      },
    ];
    for (const [index, input] of cases.entries()) {
      const book = createBook();
      const tick = book.applySnapshot(
        bookSnapshot({ asks: input.asks, bids: input.bids, hash: `case-${index}` }),
        now,
      ).tick;
      expect(tick?.quality).toBe(input.quality);
      expect(tick?.midpointX6).toBeNull();
    }

    const staleBook = createBook();
    staleBook.applySnapshot(bookSnapshot(), now);
    expect(staleBook.tick(now + 30_001n)).toMatchObject({ midpointX6: null, quality: "stale" });
    expect(staleBook.disconnect(now)).toMatchObject({ midpointX6: null, quality: "disconnected" });
  });
});
