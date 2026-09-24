import { describe, expect, test } from "bun:test";
import {
  formatPriceRawX18,
  MAX_ORDER_UINT128,
  parsePriceRawX18,
  parseShareAmount,
  parseTokenAmount,
  quoteForReservation,
} from "@conditional-stocks/domain";
import { coder, key, PROGRAM_ID, SolanaClient } from "@conditional-stocks/solana-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutcomePrice } from "../src/components/market/OutcomePrice";
import { executionImpact, executionPoints } from "../src/lib/markets/history";
import {
  groupMarkets,
  impactPercent,
  MARKET_CATEGORIES,
  marketCategory,
  marketCategoryFromPathname,
  marketCategoryFromSlug,
  marketCategoryPath,
  midpoint,
} from "../src/lib/markets/presentation";
import { outcomeLabel, safeExternalUrl } from "../src/lib/markets/resolution";
import { conditionalPositionRows } from "../src/lib/portfolio/positions";
import {
  csvCell,
  orderHistoryCsv,
  tradeHistoryCsv,
  walletTradeRows,
  wholeReserved,
} from "../src/lib/portfolio/presentation";
import { createActionScope } from "../src/lib/trading/action-scope";
import { marketPriceBound, quantityForSpend } from "../src/lib/trading/entry";
import { previewOrder } from "../src/lib/trading/order";
import { MarketDetailPageSkeleton } from "../src/modules/MarketDetailPageModule/components/MarketDetailPageSkeleton";
import { MarketsPageSkeleton } from "../src/modules/MarketsPageModule/components/MarketsPageSkeleton";
import { FEATURED_MARKETS } from "../src/modules/MarketsPageModule/featured-markets";
import { mergeOrderPages } from "../src/services/orders";
import { createUiStore } from "../src/stores/ui-store";
import { fixtureMarkets, fixtureState as state } from "./fixtures/protocol";

const market = required(fixtureMarkets[0]);
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture.");
  return value;
}
const account = PROGRAM_ID.toBase58();
describe("market category routes", () => {
  test("maps every visible category to its canonical URL and rejects unknown slugs", () => {
    expect(marketCategoryPath("All")).toBe("/");
    for (const category of ["Macro", "Earnings", "Policy", "Other"] as const) {
      const path = `/category/${category.toLowerCase()}`;
      expect(marketCategoryPath(category)).toBe(path);
      expect(marketCategoryFromSlug(category.toLowerCase())).toBe(category);
    }
    expect(marketCategoryFromSlug("all")).toBeNull();
    expect(marketCategoryFromSlug("unknown")).toBeNull();
    expect(marketCategoryFromPathname("/")).toBe("All");
    expect(marketCategoryFromPathname("/category/macro")).toBe("Macro");
    expect(marketCategoryFromPathname("/category/earnings/")).toBe("Earnings");
    expect(marketCategoryFromPathname("/markets/example")).toBeNull();
  });
});
describe("markets loading state", () => {
  test("reserves the banner and responsive card grid without loading text", () => {
    const html = renderToStaticMarkup(createElement(MarketsPageSkeleton, { view: "Feed" }));
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/data-variant="market"/g)).toHaveLength(6);
    expect(html.match(/data-slot="skeleton"/g)?.length).toBeGreaterThan(30);
    expect(html).not.toContain("Loading...");
  });
  test("reserves the complete market workspace without fallback loading copy", () => {
    const html = renderToStaticMarkup(createElement(MarketDetailPageSkeleton));
    expect(html).toContain('aria-label="Loading market"');
    for (const region of ["stats", "chart", "book", "ticket", "information"])
      expect(html).toContain(`market-workspace-${region}`);
    expect(html.match(/data-slot="skeleton"/g)?.length).toBeGreaterThan(50);
    expect(html).not.toContain("Loading...");
  });
});
describe("category featured markets", () => {
  test("assigns a distinct live condition and optimized image to every category", async () => {
    expect(Object.keys(FEATURED_MARKETS)).toEqual([...MARKET_CATEGORIES]);
    expect(new Set(Object.values(FEATURED_MARKETS).map((item) => item.conditionId)).size).toBe(5);
    expect(new Set(Object.values(FEATURED_MARKETS).map((item) => item.imageSrc)).size).toBe(5);
    for (const definition of Object.values(FEATURED_MARKETS)) {
      expect(definition.conditionId).toMatch(/^0x[a-f0-9]{64}$/);
      expect(definition.imageSrc).toMatch(/^\/markets\/.+-feature\.webp$/);
      expect(
        await Bun.file(new URL(`../public${definition.imageSrc}`, import.meta.url)).exists(),
      ).toBe(true);
    }
  });

  test("classifies the selected Clarity Act event as policy", () => {
    expect(marketCategory({ ...market, question: "Clarity Act signed into law in 2026?" })).toBe(
      "Policy",
    );
  });
});
describe("canonical order windows", () => {
  test("keeps older resting orders and prefers the newest update across reads", () => {
    const order = required(state.orders[0]);
    const newer = { ...order, id: "recent", status: "cancelled", updatedBlock: "12" };
    const stale = { ...newer, status: "open", updatedBlock: "11" };
    const oldOpen = { ...order, id: "older-open", updatedBlock: "1" };
    const result = mergeOrderPages(
      { orders: [newer], truncated: true },
      { orders: [stale, oldOpen] },
    );
    expect(result.orders).toEqual([newer, oldOpen]);
    expect(result.truncated).toBe(true);
    expect(result.openTruncated).toBe(false);
  });
  test("reports the open-order cap independently of history", () => {
    expect(mergeOrderPages({ orders: [] }, { orders: [], truncated: true })).toEqual({
      orders: [],
      truncated: false,
      openTruncated: true,
    });
  });
});
describe("share-unit amount entry", () => {
  for (const [shareDecimals, quoteTokenDecimals] of [
    [18, 6],
    [8, 6],
    [6, 18],
    [6, 6],
    [0, 6],
  ] as const) {
    test(`spend rounds inward for ${shareDecimals}/${quoteTokenDecimals} share/quote decimals`, () => {
      const m = {
        ...market,
        shareDecimals,
        quoteTokenDecimals,
        baseStep: "1",
      };
      for (const spend of ["1", "10", "12345"]) {
        const expectedRaw =
          (parseTokenAmount(spend, quoteTokenDecimals) * 10n ** 18n) / parsePriceRawX18("0.37", m);
        if (expectedRaw >= 1n << 64n) {
          expect(() => quantityForSpend(spend, "0.37", m)).toThrow();
          continue;
        }
        const quantity = quantityForSpend(spend, "0.37", m),
          raw = parseShareAmount(quantity, m);
        const price = parsePriceRawX18("0.37", m),
          budget = parseTokenAmount(spend, m.quoteTokenDecimals);
        expect(raw > 0n).toBe(true);
        expect(quoteForReservation(raw, price) <= budget).toBe(true);
        expect(quoteForReservation(raw + 1n, price) > budget).toBe(true);
      }
    });
  }
  test("quantity step and dust fail before a signature", () => {
    const m = { ...market, baseStep: "1000" };
    expect(previewOrder("0.001", "100", m).valid).toBe(true);
    expect(previewOrder("0.0001", "100", m).valid).toBe(false);
    expect(previewOrder("1", "0.000001", { ...m, baseStep: "0" }).valid).toBe(false);
    expect(previewOrder("0.000001", "0.000001", { ...m, baseStep: "1" }).valid).toBe(false);
    expect(previewOrder("0.0000001", "1", { ...m, baseStep: "1" }).valid).toBe(false);
    expect(parseShareAmount(quantityForSpend("1", "3", m), m) % BigInt(m.baseStep)).toBe(0n);
  });
  test("invalid input, uint128 overflow, and insufficient budgets are rejected", () => {
    for (const spend of [
      "-1",
      "NaN",
      "Infinity",
      "1e3",
      "0",
      "0.0000001",
      "999999999999999999999999999999999999999999999",
    ])
      expect(() => quantityForSpend(spend, "100", market)).toThrow();
    expect(() => quantityForSpend("0.000001", "100", market)).toThrow();
    expect(
      previewOrder((MAX_ORDER_UINT128 + 1n).toString(), "1", { ...market, shareDecimals: 0 }).valid,
    ).toBe(false);
  });
  test("market IOC bounds align with the tick grid without widening the 1% bound", () => {
    const m = { ...market, priceTickRawX18: "10000" };
    for (const branch of ["YES", "NO"] as const)
      for (const side of ["buy", "sell"] as const) {
        const book = branch === "YES" ? m.yes : m.no;
        const reference = parsePriceRawX18(
          required(side === "buy" ? book.bestAskExact : book.bestBidExact),
          m,
        );
        const bound = parsePriceRawX18(marketPriceBound(m, branch, side), m);
        expect(bound % 10000n).toBe(0n);
        expect(
          side === "buy"
            ? bound * 10000n <= reference * 10100n
            : bound * 10000n >= reference * 9900n,
        ).toBe(true);
      }
    expect(() =>
      marketPriceBound({ ...market, yes: { ...market.yes, bestAskExact: null } }, "YES", "buy"),
    ).toThrow();
    for (const bps of [-1, 1.1, 10000, Number.NaN])
      expect(() => marketPriceBound(market, "YES", "buy", bps)).toThrow();
  });
});
describe("wallet action scoping", () => {
  test("double clicks cannot start a second action", () => {
    const scope = createActionScope("walletA:order1"),
      action = required(scope.begin());
    expect(scope.begin()).toBeNull();
    action.assertCurrent();
    action.finish();
    expect(scope.begin()).not.toBeNull();
  });
  test("account changes, form edits, A-B-A transitions and unmount invalidate outstanding work", () => {
    for (const next of ["walletB:order1", "walletA:order2"]) {
      const scope = createActionScope("walletA:order1"),
        action = required(scope.begin());
      scope.update(next);
      scope.update("walletA:order1");
      expect(() => action.assertCurrent()).toThrow("changed");
    }
    const scope = createActionScope("wallet"),
      action = required(scope.begin());
    scope.dispose();
    scope.mount();
    expect(() => action.assertCurrent()).toThrow("changed");
  });
  test("provider-scoped stores share no wallet intent or filters between requests", () => {
    const a = createUiStore(),
      b = createUiStore();
    a.getState().setFilters({ category: "Macro", view: "Matrix" });
    a.getState().setPrefill({ marketId: market.id, branch: "NO", quantity: "0.5", nonce: 1 });
    expect(b.getState().filters.category).toBe("All");
    expect(b.getState().prefill).toBeNull();
    expect(a.getState().filters.category).toBe("Macro");
    expect(Object.keys(a.getState()).some((key) => /token|session|secret/i.test(key))).toBe(false);
  });
});
describe("Solana claim transaction construction", () => {
  test("split and merge bind the owner, market and exact SPL raw amount", () => {
    const client = new SolanaClient({
      rpcUrl: "http://127.0.0.1:8899",
      config: account,
      genesisHash: "fixture",
    });
    client.rememberMarket(key(account), {
      config: client.config,
      mints: [key(account), key("11111111111111111111111111111111")],
    });
    for (const action of ["split", "merge"] as const) {
      const ix = client.position(action, key(account), key(account), 0, 1_000_001n);
      const decoded = required(coder.instruction.decode(ix.data));
      expect(decoded.name).toBe(action);
      expect(String((decoded.data as { amount: unknown }).amount)).toBe("1000001");
      expect(ix.keys[0]?.isSigner).toBe(true);
    }
  });
});
describe("honest market, portfolio and evidence presentation", () => {
  test("one-sided, crossed and missing books never imply a midpoint or zero price", () => {
    expect(midpoint({ ...market.yes, bestBid: null })).toBeNull();
    expect(midpoint({ ...market.yes, bestBid: 101, bestAsk: 100 })).toBeNull();
    expect(impactPercent({ ...market, no: { ...market.no, bestAsk: null } })).toBeNull();
    expect(
      impactPercent({
        ...market,
        yes: { ...market.yes, bestBid: 199, bestAsk: 201 },
        no: { ...market.no, bestBid: 99, bestAsk: 101 },
      }),
    ).toBe(100);
  });
  test("market card labels one-sided executable quotes without inventing a midpoint", () => {
    const askOnly = renderToStaticMarkup(
      createElement(OutcomePrice, {
        market: { ...market, yes: { ...market.yes, bestBid: null } },
        branch: "YES",
      }),
    );
    expect(askOnly).toContain("Ask");
    expect(askOnly).not.toContain("spot impact unavailable</span>");
    const crossed = renderToStaticMarkup(
      createElement(OutcomePrice, {
        market: { ...market, yes: { ...market.yes, bestBid: 101, bestAsk: 100 } },
        branch: "YES",
      }),
    );
    expect(crossed).not.toContain("Ask</span>");
    expect(crossed).toContain("—");
  });
  test("event grouping follows immutable Polymarket identity across local windows and states", () => {
    const pair = { ...market, id: `0x${"12".repeat(32)}`, ticker: "TSLA" };
    expect(groupMarkets([market, pair])).toHaveLength(1);
    expect(groupMarkets([market, { ...pair, cutoff: "different" }])).toHaveLength(1);
    expect(groupMarkets([market, { ...pair, lifecycle: "resolved" as const }])).toHaveLength(1);
    expect(
      groupMarkets([market, { ...pair, mapping: { ...pair.mapping, noIndex: "4" } }]),
    ).toHaveLength(2);
    expect(
      groupMarkets([
        market,
        { ...pair, mapping: { ...pair.mapping, conditionId: `0x${"34".repeat(32)}` } },
      ]),
    ).toHaveLength(2);
  });
  test("event grouping deduplicates retried markets for the same asset", () => {
    const retry = {
      ...market,
      id: `0x${"99".repeat(32)}`,
      tradingOpen: "2099-02-01T00:00:00.000Z",
    };
    const [group] = groupMarkets([retry, market]);
    expect(group).toHaveLength(1);
    expect(group?.[0]?.id).toBe(market.id);
    const frozen = { ...market, lifecycle: "frozen" as const };
    expect(groupMarkets([frozen, retry])[0]?.[0]?.id).toBe(retry.id);
  });
  test("whole-asset reservations follow the delivered issuer token of each sell", () => {
    const order = {
      ...required(state.orders[0]),
      marketId: market.id,
      status: "open",
      fundingKind: 0,
      side: 1,
      reserved: "9",
    };
    const legX = market.bases[0]!.mint,
      legOn = market.bases[1]!.mint;
    const orders = [
      { ...order, bases: 1 },
      { ...order, id: "b", bases: 2, reserved: "4" },
      { ...order, id: "c", bases: 2, baseCollateral: 1, reserved: "1" },
    ];
    expect(wholeReserved(legX, orders, [market])).toBe(10n);
    expect(wholeReserved(legOn, orders, [market])).toBe(4n);
  });
  test("whole-asset reservations exclude claim collateral and closed orders", () => {
    const order = {
      ...required(state.orders[0]),
      marketId: market.id,
      status: "open",
      fundingKind: 0,
      side: 0,
      reserved: "123",
    };
    expect(
      wholeReserved(
        market.quoteToken,
        [
          order,
          { ...order, fundingKind: 1 },
          { ...order, status: "cancelled" },
          { ...order, side: 1 },
        ],
        [market],
      ),
    ).toBe(123n);
  });
  test("sibling event markets keep their USDC claims and reservations separate", () => {
    const baseOrder = required(state.orders[0]);
    const basePosition = required(state.positions[0]);
    const secondMarket = {
      ...market,
      id: `0x${"31".repeat(32)}`,
      assetKey: "asset:SPY",
      ticker: "SPY",
    };
    const rows = conditionalPositionRows(
      [market, secondMarket],
      [basePosition, { ...basePosition, marketId: secondMarket.id }],
      [
        {
          ...baseOrder,
          status: "open",
          fundingKind: 1,
          side: 0,
          branch: 0,
          reserved: "123",
        },
        {
          ...baseOrder,
          id: `0x${"33".repeat(32)}`,
          marketId: secondMarket.id,
          status: "open",
          fundingKind: 1,
          side: 0,
          branch: 0,
          reserved: "77",
        },
        {
          ...baseOrder,
          id: `0x${"34".repeat(32)}`,
          status: "open",
          fundingKind: 1,
          side: 1,
          bases: 2,
          branch: 0,
          reserved: "55",
        },
      ],
    );
    const quoteRows = rows.filter((row) => row.kind === "quote");
    expect(quoteRows).toHaveLength(4);
    expect(quoteRows.map((row) => `${row.symbol}-${row.branch === 0 ? "YES" : "NO"}`)).toEqual([
      "USDC-YES",
      "USDC-NO",
      "USDC-YES",
      "USDC-NO",
    ]);
    expect(quoteRows[0]?.reserved).toBe(123n);
    expect(quoteRows[2]?.reserved).toBe(77n);
    // Claim reservations stay with the delivered issuer's own claims.
    expect(rows.find((row) => row.key === `stock-${market.id}-2-0`)?.reserved).toBe(55n);
    expect(rows.find((row) => row.key === `stock-${market.id}-1-0`)?.reserved).toBe(0n);
    const stock = rows.filter((row) => row.kind === "stock" && row.market.id === market.id);
    expect(stock.map((row) => `${row.symbol}-${row.branch === 0 ? "YES" : "NO"}`)).toEqual([
      "NVDAx-YES",
      "NVDAx-NO",
      "NVDAon-YES",
    ]);
    expect(stock.map((row) => row.decimals)).toEqual([8, 8, 9]);
  });
  test("invalid payout is not incorrectly reported YES merely because numerator is one", () => {
    const r = {
      admin: null,
      evidenceHash: null,
      evidenceUri: null,
      transactionHash: null,
      yesPayout: "1",
      noPayout: "1",
      payoutDenominator: "2",
    };
    expect(outcomeLabel(r)).toBe("Invalid · 50/50");
    expect(outcomeLabel({ ...r, noPayout: "0", payoutDenominator: "1" })).toBe("YES");
    expect(outcomeLabel({ ...r, yesPayout: "0", payoutDenominator: "1" })).toBe("NO");
    expect(outcomeLabel({ ...r, payoutDenominator: "0" })).toBe("Unverified payout");
    expect(outcomeLabel(null)).toBe("Pending");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "http://evil.test",
      "https://user:pass@host.test",
      "/local",
    ])
      expect(safeExternalUrl(url)).toBeNull();
    expect(safeExternalUrl("https://example.com/evidence")).toBe("https://example.com/evidence");
  });
  test("CSV escapes labels and spreadsheet formula injection without losing exact raw-unit quantities", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=1+1")).toBe('"\'=1+1"');
    expect(csvCell("\t@SUM(A1)")).toContain("'");
    const order = {
      ...required(state.orders[0]),
      marketId: market.id,
      quantity: "1000001",
      filled: "1",
      limitPriceRawX18: "123456789",
    };
    const csv = orderHistoryCsv([order], [market]);
    expect(csv.split("\r\n")[0]).toContain('"Limit (USDC)"');
    expect(csv).toContain("1.000001");
    expect(csv).toContain('"Any issuer"');
    expect(csv).toContain(formatPriceRawX18(123456789n, market));
    expect(csv).toContain("Updated block");
  });
  test("wallet trade history includes only fills belonging to the connected wallet orders", () => {
    const order = required(state.orders[0]);
    const trade = {
      ...required(state.trades[0]),
      buyOrderHash: order.id,
      sellOrderHash: `0x${"44".repeat(32)}`,
      executionQuote: "255250000",
    };
    const unrelated = {
      ...trade,
      id: `0x${"55".repeat(32)}`,
      buyOrderHash: `0x${"66".repeat(32)}`,
    };
    const rows = walletTradeRows([trade, unrelated], [order], [market]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.side).toBe("Buy");
    expect(tradeHistoryCsv(rows)).toContain('"255.25"');
  });
  test("wallet trade history identifies self-matches without double-counting the fill", () => {
    const buy = required(state.orders[0]);
    const sell = { ...buy, id: `0x${"77".repeat(32)}`, side: 1 };
    const trade = {
      ...required(state.trades[0]),
      buyOrderHash: buy.id,
      sellOrderHash: sell.id,
    };
    const rows = walletTradeRows([trade], [buy, sell], [market]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.side).toBe("Self-match");
  });
  test("wallet trade history matches canonical Solana maker and taker order hashes", () => {
    const buy = required(state.orders[0]);
    const sell = { ...buy, id: "solana-sell-order", side: 1 };
    const makerFill = {
      ...required(state.trades[0]),
      makerOrderHash: sell.id,
      takerOrderHash: "unrelated-taker",
    };
    const takerFill = {
      ...required(state.trades[0]),
      id: "second-solana-fill",
      makerOrderHash: "unrelated-maker",
      takerOrderHash: buy.id,
    };
    const rows = walletTradeRows([makerFill, takerFill], [buy, sell], [market]);
    expect(rows.map((row) => row.side)).toEqual(["Sell", "Buy"]);
  });
  test("historical impact waits for both branch executions and respects market and time boundaries", () => {
    const points = [
      { id: "a", at: 1, branch: 0, price: 200 },
      { id: "b", at: 2, branch: 1, price: 100 },
      { id: "c", at: 3, branch: 0, price: 210 },
    ];
    expect(executionImpact(points.slice(0, 1))).toEqual([]);
    expect(executionImpact(points).map((p) => p.price)).toEqual([100, 110.00000000000001]);
    expect(executionPoints(state.trades, { ...market, id: "different" })).toEqual([]);
    expect(executionPoints(state.trades, market, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});
