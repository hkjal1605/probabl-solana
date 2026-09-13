import { describe, expect, test } from "bun:test";
import { SolanaClient,key,PROGRAM_ID,coder } from "@conditional-stocks/solana-client";
import {
  formatPriceRawX18,
  MAX_ORDER_UINT128,
  parsePriceRawX18,
  parseTokenAmount,
  quoteForReservation,
} from "@conditional-stocks/domain";
import { mergeOrderPages } from "../src/lib/api/orders";
import { executionImpact, executionPoints } from "../src/lib/markets/history";
import { groupMarkets, impactPercent, midpoint } from "../src/lib/markets/presentation";
import { outcomeLabel, safeExternalUrl } from "../src/lib/markets/resolution";
import { csvCell, orderHistoryCsv, wholeReserved } from "../src/lib/portfolio/presentation";
import { createActionScope } from "../src/lib/trading/action-scope";
import { marketPriceBound, quantityForSpend } from "../src/lib/trading/entry";
import { previewOrder } from "../src/lib/trading/order";
import { createUiStore } from "../src/stores/ui-store";
import { fixtureMarkets, fixtureState as state } from "./fixtures/protocol";

const market = required(fixtureMarkets[0]);
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture.");
  return value;
}
const account = PROGRAM_ID.toBase58();
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
describe("raw-unit amount entry", () => {
  for (const [baseTokenDecimals, quoteTokenDecimals] of [
    [18, 6],
    [8, 6],
    [6, 18],
    [6, 6],
    [0, 6],
  ] as const) {
    test(`spend rounds inward for ${baseTokenDecimals}/${quoteTokenDecimals} decimal tokens`, () => {
      const m = {
        ...market,
        baseTokenDecimals,
        quoteTokenDecimals,
        baseStep: "1",
      };
      for (const spend of ["1", "10", "12345"]) {
        const expectedRaw=(parseTokenAmount(spend,quoteTokenDecimals)*10n**18n)/parsePriceRawX18("0.37",m);
        if(expectedRaw>=1n<<64n){expect(()=>quantityForSpend(spend,"0.37",m)).toThrow();continue;}
        const quantity = quantityForSpend(spend, "0.37", m),
          raw = parseTokenAmount(quantity, m.baseTokenDecimals);
        const price = parsePriceRawX18("0.37", m),
          budget = parseTokenAmount(spend, m.quoteTokenDecimals);
        expect(raw > 0n).toBe(true);
        expect(quoteForReservation(raw, price) <= budget).toBe(true);
        expect(quoteForReservation(raw + 1n, price) > budget).toBe(true);
      }
    });
  }
  test("quantity step and dust fail before a signature", () => {
    const m = { ...market, baseStep: "1000000000000000" };
    expect(previewOrder("0.001", "100", m).valid).toBe(true);
    expect(previewOrder("0.0001", "100", m).valid).toBe(false);
    expect(previewOrder("1", "0.000001", { ...m, baseStep: "0" }).valid).toBe(false);
    expect(previewOrder("0.000000000000000001", "1", { ...m, baseStep: "1" }).valid).toBe(false);
    expect(parseTokenAmount(quantityForSpend("1", "3", m), 18) % BigInt(m.baseStep)).toBe(0n);
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
      previewOrder((MAX_ORDER_UINT128 + 1n).toString(), "1", { ...market, baseTokenDecimals: 0 })
        .valid,
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
    a.getState().setFilters({ query: "NVDA", view: "Matrix" });
    a.getState().setFunds("Withdraw");
    a.getState().setPrefill({ marketId: market.id, branch: "NO", quantity: "0.5", nonce: 1 });
    expect(b.getState().filters.query).toBe("");
    expect(b.getState().funds).toBeNull();
    expect(b.getState().prefill).toBeNull();
    expect(a.getState().filters.category).toBe("All");
    expect(Object.keys(a.getState()).some((key) => /token|session|secret/i.test(key))).toBe(false);
  });
});
describe("Solana claim transaction construction",()=>{
  test("split and merge bind the owner, market and exact SPL raw amount",()=>{
    const client=new SolanaClient({rpcUrl:"http://127.0.0.1:8899",config:account,genesisHash:"fixture"});
    for(const action of ["split","merge"]as const){
      const ix=client.position(action,key(account),key(account),0,1_000_001n);
      const decoded=coder.instruction.decode(ix.data)!;
      expect(decoded.name).toBe(action);
      expect(String((decoded.data as {amount:unknown}).amount)).toBe("1000001");
      expect(ix.keys[0]!.isSigner).toBe(true);
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
  test("event grouping cannot mix different evidence mappings, trading windows or lifecycle states", () => {
    const pair = { ...market, id: `0x${"12".repeat(32)}`, ticker: "TSLA" };
    expect(groupMarkets([market, pair])).toHaveLength(1);
    for (const other of [
      { ...pair, cutoff: "different" },
      { ...pair, lifecycle: "resolved" as const },
      { ...pair, mapping: { ...pair.mapping, noIndex: "4" } },
    ])
      expect(groupMarkets([market, other])).toHaveLength(2);
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
      quantity: "1000000000000000001",
      filled: "1",
      limitPriceRawX18: "123456789",
    };
    const csv = orderHistoryCsv([order], [market]);
    expect(csv).toContain("1.000000000000000001");
    expect(csv).toContain(formatPriceRawX18(123456789n, market));
    expect(csv).toContain("Updated block");
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
