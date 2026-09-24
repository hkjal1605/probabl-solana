import { describe, expect, test } from "bun:test";
import { formatShareAmount, formatTokenAmount, parseShareAmount } from "@conditional-stocks/domain";
import { baseRaw, multiplierBits } from "@conditional-stocks/solana-client";
import {
  bestLevelFor,
  buyMask,
  defaultBuyMask,
  defaultSellLeg,
  deliveredRaw,
  legStatus,
  legStatuses,
  maskLabel,
  orderLeg,
  sellReservation,
  sharesForRaw,
} from "../src/lib/markets/legs";
import { depthLevels } from "../src/lib/markets/visible-depth";
import { conditionalPositionRows } from "../src/lib/portfolio/positions";
import { bestPriceFor, marketPriceBound } from "../src/lib/trading/entry";
import { parsePosition, positionHasClaims } from "../src/services/index-stream";
import type { MarketLegView, MarketView } from "../src/types/api";
import { DIVIDEND_BITS, fixtureMarkets, fixtureState, UNIT_BITS } from "./fixtures/protocol";

const market = fixtureMarkets[0]!;
const [legX, legOn, legR] = market.bases as [MarketLegView, MarketLegView, MarketLegView];
const withLegs = (...bases: MarketLegView[]): MarketView => ({ ...market, bases });

describe("issuer leg status", () => {
  test("live issuer state decides tradability; halted legs carry a reason", () => {
    expect(legStatus(legX)).toMatchObject({ tradable: true, halt: null, liveKnown: true });
    expect(legStatus(legX).multiplier).toBe(BigInt(DIVIDEND_BITS));
    expect(legStatus(legOn)).toMatchObject({ tradable: true, liveKnown: false });
    expect(legStatus(legOn).multiplier).toBe(BigInt(UNIT_BITS));
    expect(legStatus(legR)).toMatchObject({ tradable: false, halt: "issuer-paused" });
    expect(legStatus(legR).reason).toContain("Paused by the issuer");
  });
  test("listing state halts delisted, unready and out-of-band legs without live data", () => {
    const { live: _live, ...listed } = legX;
    expect(legStatus({ ...listed, active: false }).halt).toBe("delisted");
    expect(legStatus({ ...listed, ready: false }).halt).toBe("claims-uninitialized");
    // A 2:1 split leaves the 4/5..5/4 dividend band.
    const split = {
      ...legX,
      live: {
        ...legX.live!,
        multiplier: multiplierBits(2).toString(),
        multiplierValue: 2,
      },
    };
    expect(legStatus(split)).toMatchObject({ tradable: false, halt: "corporate-action" });
    expect(legStatus({ ...legX, live: { ...legX.live!, vaultFrozen: true } }).halt).toBe(
      "vault-frozen",
    );
  });
});

describe("bases mask building", () => {
  test("buys default to every tradable issuer; halted issuers are never accepted", () => {
    expect(defaultBuyMask(market)).toBe(0b011);
    expect(buyMask(market, null)).toBe(0b011);
    expect(buyMask(market, [2])).toBe(0b010);
    expect(buyMask(market, [1, 3])).toBe(0b001);
    expect(buyMask(market, [3])).toBe(0);
    expect(buyMask(market, [])).toBe(0);
    expect(defaultBuyMask(withLegs(legR))).toBe(0);
  });
  test("labels name the accepted issuer set", () => {
    expect(maskLabel(market, 0b111)).toBe("Any issuer");
    expect(maskLabel(market, 0b011)).toBe("NVDAx + NVDAon");
    expect(maskLabel(market, 0b100)).toBe("NVDAr");
    expect(maskLabel(market, 0)).toBe("No issuer");
  });
  test("sells default to the tradable issuer the wallet holds most of", () => {
    expect(defaultSellLeg(market, {})).toBe(1);
    expect(defaultSellLeg(market, { 1: 5n, 2: 9n })).toBe(2);
    // Holding only a halted issuer does not select it.
    expect(defaultSellLeg(market, { 3: 100n })).toBe(1);
    expect(defaultSellLeg(withLegs(legR), { 3: 100n })).toBeNull();
  });
  test("an indexed sell identifies its delivered leg", () => {
    const order = fixtureState.orders[0]!;
    expect(orderLeg({ ...order, side: 1, bases: 4 })).toBe(3);
    expect(orderLeg({ ...order, side: 1, bases: 4, baseCollateral: 2 })).toBe(2);
    expect(orderLeg({ ...order, side: 0, bases: 7 })).toBeNull();
    expect(orderLeg({ ...order, side: 1, bases: 3 })).toBeNull();
  });
});

describe("raw reservation at the live multiplier", () => {
  test("a sell reserves raw issuer units rounded up, deliveries round down", () => {
    const status = legStatus(legX);
    const quantity = parseShareAmount("1.5", market);
    const reserved = sellReservation(quantity, status);
    expect(reserved).toBe(baseRaw(quantity, 100n, BigInt(DIVIDEND_BITS), true));
    expect(reserved - deliveredRaw(quantity, status)).toBe(1n);
    // 1.5 shares at x1.0017 need fewer than 1.5 NVDAx tokens (8 decimals).
    expect(formatTokenAmount(reserved, legX.decimals)).toBe("1.49745433");
    // A 9-decimal leg without ScaledUiAmount converts 1:1.
    expect(sellReservation(quantity, legStatus(legOn))).toBe(1_500_000_000n);
  });
  test("closing a claim balance finds the largest step-aligned quantity that fits", () => {
    const step = BigInt(market.baseStep);
    for (const [leg, raw] of [
      [legX, 149_745_432n],
      [legX, 1n],
      [legOn, 2_000_000_000n],
      [legOn, 1_234_567_891n],
    ] as const) {
      const status = legStatus(leg);
      const shares = sharesForRaw(raw, status, step);
      expect(shares % step).toBe(0n);
      if (shares > 0n) expect(sellReservation(shares, status) <= raw).toBe(true);
      expect(sellReservation(shares + step, status) > raw).toBe(true);
    }
    expect(formatShareAmount(sharesForRaw(149_745_433n, legStatus(legX), step), market)).toBe(
      "1.5",
    );
  });
});

describe("issuer-aware book prices and depth", () => {
  test("best prices only consider asks of accepted issuers or bids accepting the sold issuer", () => {
    expect(bestPriceFor(market, "YES", "buy", 0b111)).toBe("255.25");
    expect(bestPriceFor(market, "YES", "buy", 0b001)).toBe("255.85");
    expect(bestPriceFor(market, "YES", "buy", 0b100)).toBe("280");
    expect(bestPriceFor(market, "YES", "sell", 0b001)).toBe("254.35");
    expect(bestPriceFor(market, "YES", "sell", 0b100)).toBe("254.35");
    expect(bestPriceFor(market, "NO", "sell", 0b100)).toBe("216.95");
    expect(bestPriceFor(market, "NO", "sell", 0b010)).toBe("216.95");
    expect(bestPriceFor(market, "YES", "buy", 0)).toBeNull();
    const bound = marketPriceBound(market, "YES", "buy", 100, 0b001);
    expect(Number(bound)).toBeCloseTo(255.85 * 1.01, 6);
    expect(() => marketPriceBound(market, "YES", "buy", 100, 0)).toThrow();
    // Levels without an issuer breakdown remain usable for any selection.
    const legacy = { ...market.yes, asks: [{ priceExact: "1", price: 1, quantity: 1 }] };
    expect(bestLevelFor(legacy, "buy", 0b100)?.priceExact).toBe("1");
  });
  test("visible depth aggregates shares by issuer filter with running totals", () => {
    const listed = 0b111;
    const all = depthLevels(market.yes.asks, 10, null, listed);
    expect(all.map((l) => [l.price, l.quantity, l.cumulative, l.mask])).toEqual([
      [255.25, 1, 1, 2],
      [255.85, 3, 4, 1],
      [256.45, 4, 8, 3],
      [280, 1, 9, 4],
    ]);
    const x = depthLevels(market.yes.asks, 10, 0b001, listed);
    expect(x.map((l) => [l.price, l.quantity, l.cumulative])).toEqual([
      [255.85, 3, 3],
      [256.45, 1, 4],
    ]);
    expect(depthLevels(market.yes.asks, 2, null, listed)).toHaveLength(2);
    expect(depthLevels(market.yes.asks, 0, null, listed)).toHaveLength(0);
    const bids = depthLevels(market.yes.bids, 10, 0b100, listed);
    expect(bids.map((l) => [l.price, l.quantity, l.anyIssuer])).toEqual([
      [254.35, 2, true],
      [253.15, 3, false],
    ]);
  });
});

describe("per-issuer positions", () => {
  test("claims are rows per issuer in their own decimals plus quote rows", () => {
    const rows = conditionalPositionRows([market], fixtureState.positions, []);
    expect(rows.map((row) => [row.symbol, row.branch, row.decimals, row.total])).toEqual([
      ["NVDAx", 0, 8, 500_000_000n],
      ["NVDAx", 1, 8, 500_000_000n],
      ["NVDAon", 0, 9, 2_000_000_000n],
      ["USDC", 0, 6, 1_000_000_000n],
      ["USDC", 1, 6, 1_255_250_000n],
    ]);
    expect(rows[0]?.multiplier).toBe(1.0017);
    expect(rows.every((row) => (row.kind === "quote") === (row.collateral === 0))).toBe(true);
  });
  test("streamed v3 positions are validated per issuer", () => {
    const position = {
      ...fixtureState.positions[0]!,
      marketId: legX.mint,
      conditionId: legX.mint,
    };
    expect(parsePosition(position)).toBe(position);
    // Legs without initialized claims are omitted; the others keep their collateral.
    const sparse = { ...position, bases: [position.bases[0]!, position.bases[2]!] };
    expect(parsePosition(sparse)).toBe(sparse);
    expect(positionHasClaims(position)).toBe(true);
    expect(
      positionHasClaims({
        ...position,
        quoteYes: "0",
        quoteNo: "0",
        bases: position.bases.map((leg) => ({ ...leg, yes: "0", no: "0" })),
      }),
    ).toBe(false);
    for (const bad of [
      { ...position, protocolVersion: 2 },
      { ...position, bases: [...position.bases].reverse() },
      { ...position, bases: [{ ...position.bases[0]!, yes: "-1" }] },
      { ...position, bases: [...position.bases, { ...position.bases[0]!, collateral: 4 }] },
      { ...position, shareDecimals: 99 },
    ])
      expect(() => parsePosition(bad)).toThrow();
  });
});

test("fixture legs match the listing math", () => {
  expect(legStatuses(market).map((status) => status.scale)).toEqual([100n, 1000n, 1000n]);
});

test("closing an issuer claim position pre-fills that issuer and a fitting share quantity", async () => {
  const { closePrefill } = await import("../src/components/portfolio/PositionTable");
  const rows = conditionalPositionRows([market], fixtureState.positions, []);
  const x = closePrefill(rows[0]!);
  expect(x).toMatchObject({ marketId: market.id, branch: "YES", collateral: 1 });
  // 5 NVDAx-YES at x1.0017 are 5.0085 shares, rounded down to the 0.001 step.
  expect(x.quantity).toBe("5.008");
  expect(closePrefill(rows[2]!)).toMatchObject({ collateral: 2, quantity: "2" });
});
