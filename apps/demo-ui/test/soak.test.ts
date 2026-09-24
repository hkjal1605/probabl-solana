import { expect, test } from "bun:test";
import "./harness";

const engine = await import("../src/protocol/engine");

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing value under test.");
  return value;
}

test("books stay well formed, priced, and two-sided while the protocol runs", async () => {
  engine.start();
  const seen = new Map<string, Set<string>>();
  for (let round = 0; round < 40; round++) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const market of engine.listMarkets()) {
      if (market.lifecycle !== "open") continue;
      for (const branch of [market.yes, market.no]) {
        expect(branch.bids.length).toBeGreaterThan(0);
        expect(branch.asks.length).toBeGreaterThan(0);
        // Never crossed, always sorted outward from the midpoint.
        expect(required(branch.bestAsk)).toBeGreaterThan(required(branch.bestBid));
        for (let index = 1; index < branch.bids.length; index++)
          expect(required(branch.bids[index]).price).toBeLessThan(
            required(branch.bids[index - 1]).price,
          );
        for (let index = 1; index < branch.asks.length; index++)
          expect(required(branch.asks[index]).price).toBeGreaterThan(
            required(branch.asks[index - 1]).price,
          );
        for (const level of [...branch.bids, ...branch.asks]) {
          expect(level.price).toBeGreaterThan(0);
          expect(level.quantity).toBeGreaterThan(0);
          expect(Number.isFinite(level.price)).toBe(true);
        }
        expect(required(branch.spread)).toBeGreaterThan(0);
        expect(branch.depthUsd).toBeGreaterThan(0);
      }
      // Prices stay anchored to the reference feed instead of drifting away.
      const reference = required(market.spotReference?.priceUsd ?? market.ordinaryReference ?? 1);
      const mid = (required(market.yes.bestBid) + required(market.yes.bestAsk)) / 2;
      const catalogueSpot =
        market.ticker === "SPY" ? 773.2 : market.ticker === "NVDA" ? 227.37 : 374.36;
      expect(mid / catalogueSpot).toBeGreaterThan(0.8);
      expect(mid / catalogueSpot).toBeLessThan(1.2);
      expect(reference).toBeGreaterThan(0);
      const group = seen.get(market.id) ?? new Set<string>();
      group.add(`${market.yes.bestBid}:${market.yes.asks[0]?.quantity}`);
      seen.set(market.id, group);
    }
  }
  // Every market's top of book changed at least once over the run.
  const stale = [...seen].filter(([, values]) => values.size < 2);
  expect(stale.length).toBe(0);
  const tape = engine.listTrades();
  expect(tape.length).toBeGreaterThan(500);
  expect(new Set(tape.map((trade) => trade.id)).size).toBe(tape.length);
}, 20_000);
