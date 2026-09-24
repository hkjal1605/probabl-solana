import { beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { navigation } from "./harness";

const { createRoot } = await import("react-dom/client");
const { AppProviders } = await import("../src/components/providers/AppProviders");
const { MarketsExplorer } = await import(
  "../src/modules/MarketsPageModule/components/MarketsExplorer"
);
const { PortfolioClient } = await import(
  "../src/modules/PortfolioPageModule/components/PortfolioClient"
);
const { MarketWorkspace } = await import(
  "../src/modules/MarketDetailPageModule/components/MarketWorkspace"
);
const { OrdersClient } = await import("../src/modules/OrdersPageModule/components/OrdersClient");
const { SiteHeader } = await import("../src/components/layout/SiteHeader");
const { ResolutionClient } = await import(
  "../src/modules/ResolutionPageModule/components/ResolutionClient"
);
const engine = await import("../src/protocol/engine");
const { CATALOGUE_EVENTS, CATALOGUE_MARKETS } = await import("../src/protocol/catalogue");
const { LIFECYCLE_OVERRIDES } = await import("../src/protocol/config");

const host = document.createElement("div");
document.body.appendChild(host);
let root = createRoot(host);

const flush = async (times = 6) => {
  for (let index = 0; index < times; index++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
};

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(<AppProviders>{node}</AppProviders>);
  });
  await flush();
}

async function unmount() {
  await act(async () => {
    root.unmount();
  });
  root = createRoot(host);
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing value under test.");
  return value;
}

/** Reads settle on the next protocol tick, so wait for the view instead of a fixed delay. */
async function waitFor(what: string, ready: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await flush(2);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const text = () => document.body.textContent ?? "";
const buttons = () => [...document.body.querySelectorAll("button")] as HTMLButtonElement[];
const byText = (label: string) =>
  buttons().find((button) => (button.textContent ?? "").trim() === label);

async function click(element: Element | undefined) {
  if (!element) throw new Error("Element is not rendered");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function type(input: Element | null | undefined, value: string) {
  if (!input) throw new Error("Input is not rendered");
  const field = input as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(3);
}

beforeAll(() => {
  engine.resetWallet();
  engine.start();
});

test("the markets page lists every catalogued event with live prices", async () => {
  navigation.pathname = "/";
  await render(<MarketsExplorer markets={[]} category="All" />);
  const body = text();
  const settled = new Set(Object.keys(LIFECYCLE_OVERRIDES));
  for (const event of CATALOGUE_EVENTS) {
    if (settled.has(event.conditionId)) expect(body).not.toContain(event.question);
    else expect(body).toContain(event.question);
  }
  // Featured banner, probability gauges, and per-asset outcome prices.
  expect(body).toContain("Featured market");
  expect(body).toMatch(/\d+% *Asset/);
  expect(host.querySelectorAll('a[href^="/markets/"]').length).toBeGreaterThan(30);
  expect(body).toContain("liquidity");
  await unmount();
});

test("category routes filter the same catalogue", async () => {
  navigation.pathname = "/category/earnings";
  await render(<MarketsExplorer markets={[]} category="Earnings" />);
  expect(text()).toContain("beat quarterly earnings");
  expect(text()).not.toContain("Fed rate cut by December 2026 meeting?");
  await unmount();
  navigation.pathname = "/";
});

test("a market page renders both books, the tape, and the trade ticket", async () => {
  const market = CATALOGUE_MARKETS.find((row) => row.ticker === "NVDA");
  if (!market) throw new Error("Missing catalogue market");
  await render(<MarketWorkspace marketId={market.id} />);
  const body = text();
  expect(body).toContain("NVDA-YES");
  expect(body).toContain("Size (Cumm)");
  expect(body).toContain("spr");
  expect(body).toContain("Order value");
  expect(body).toContain("Worst price · 1% bound");
  expect(body).toContain("Cutoff");
  // Price rows are real numbers, not placeholders.
  const rows = [...host.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
  expect(rows.filter((row) => /\d+\.\d\d/.test(row)).length).toBeGreaterThan(5);
  expect(byText("Connect wallet")).toBeDefined();
  await unmount();
});

test("connecting funds the account, and deposits move tokens into the vault", async () => {
  await render(<PortfolioClient markets={[]} />);
  expect(text()).toContain("Connect your wallet to view balances");
  await click(byText("Connect wallet"));
  expect(text()).toContain("Portfolio");
  expect(text()).toContain("Trading vault");
  expect(text()).toContain("USDC");
  // Wallet column shows the starting holdings before anything is deposited.
  expect(text()).toContain("25000");

  await click(buttons().find((button) => button.textContent?.trim() === "Deposit"));
  await type(document.querySelector("#vault-amount"), "5000");
  await click(
    buttons()
      .filter((button) => button.textContent?.trim() === "Deposit")
      .at(-1),
  );
  const quote = required(engine.listMarkets()[0]).quoteToken;
  await waitFor(
    "the credited deposit",
    () => required(engine.walletSnapshot().balances[quote]).vaultAvailable === "5000000000",
  );
  await waitFor("the vault summary", () => text().includes("Total balance"));
  await unmount();
});

test("one approval enables trading from the deposited balance", async () => {
  await render(<PortfolioClient markets={[]} />);
  expect(engine.permission().active).toBe(false);
  await click(byText("Enable trading"));
  await click(byText("Approve in wallet"));
  await waitFor("the approved trading key", () => engine.permission().active);
  await waitFor("the granted limits", () => text().includes("Remaining lifetime limit"));
  await unmount();
});

test("a market order fills against resting depth and credits claims", async () => {
  const market = engine
    .listMarkets()
    .find((row) => row.lifecycle === "open" && row.ticker === "NVDA");
  if (!market) throw new Error("Missing open market");
  await render(<MarketWorkspace marketId={market.id} />);
  await type(document.querySelector("#ticket-quantity"), "0.5");
  await waitFor(
    "the reviewed order",
    () => byText("Place order")?.disabled === false && text().includes("Fill now"),
  );
  await click(byText("Place order"));
  await waitFor("the settled fill", () => engine.listOrders().orders.length > 0);
  const snapshot = engine.walletSnapshot();
  const position = required(snapshot.positions.find((row) => row.marketId === market.id));
  const order = required(engine.listOrders().orders[0]);
  // Stock claims credited always equal the quantity actually filled.
  expect(BigInt(order.filled)).toBeGreaterThan(0n);
  expect(BigInt(order.filled)).toBeLessThanOrEqual(500_000n);
  expect(BigInt(position.stockYes)).toBe(BigInt(order.filled));
  // A whole-token buy also mints the complementary cash claim on the other branch.
  expect(BigInt(position.quoteNo)).toBeGreaterThan(0n);
  expect(order.status).toBe("filled");
  expect(BigInt(order.reserved)).toBe(0n);
  await unmount();
});

test("a resting limit order shows in the book and can be cancelled", async () => {
  const market = engine
    .listMarkets()
    .find((row) => row.lifecycle === "open" && row.ticker === "SPY");
  if (!market) throw new Error("Missing open market");
  const bid = Number(market.yes.bestBidExact);
  engine.submitOrder({
    marketId: market.id,
    branch: "YES",
    side: "buy",
    tif: "gtc",
    funding: "whole",
    quantityRaw: "100000",
    limitPriceRawX18: (BigInt(Math.round((bid - 5) * 100)) * 10n ** 16n).toString(),
    maxFeeBps: 0,
  });
  await render(<OrdersClient markets={engine.listMarkets()} />);
  await waitFor("the resting order row", () => text().includes("SPY-YES"));
  expect(text()).toContain("GTC · Whole");
  expect(text()).toContain("open");
  await click(byText("Cancel"));
  await waitFor(
    "the released escrow",
    () =>
      engine.listOrders().orders.find((row) => row.marketId === market.id)?.status === "cancelled",
  );
  await unmount();
});

test("claims can be split and merged, and the portfolio reflects both", async () => {
  const market = engine
    .listMarkets()
    .find((row) => row.lifecycle === "open" && row.ticker === "NVDA");
  if (!market) throw new Error("Missing open market");
  engine.deposit(market.baseToken, 10_000_000n);
  engine.claimAction({
    kind: "Split",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 4_000_000n,
  });
  const after = engine.walletSnapshot().positions.find((row) => row.marketId === market.id);
  expect(BigInt(required(after).stockNo)).toBe(4_000_000n);
  await render(<PortfolioClient markets={[]} />);
  await waitFor("the split claims", () => text().includes("NVDA-NO"));
  const body = text();
  expect(body).toContain("Claims");
  expect(body).toContain("Positions");
  expect(body).toContain("Trade history");
  expect(body).toContain("Buy");
  await unmount();
});

test("a settled market exposes its payout and redeems winning claims", async () => {
  const market = engine.listMarkets().find((row) => row.lifecycle === "redeemable");
  if (!market) throw new Error("Missing settled market");
  const resolution = engine.resolution(market.id);
  expect(resolution?.yesPayout).toBe("1");
  expect(resolution?.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  engine.deposit(market.baseToken, 3_000_000n);
  engine.claimAction({
    kind: "Split",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 3_000_000n,
  });
  const before = required(engine.walletSnapshot().balances[market.baseToken]).vaultAvailable;
  engine.claimAction({
    kind: "Redeem",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 0n,
  });
  const snapshot = engine.walletSnapshot();
  // A YES settlement returns the full collateral for a complete YES/NO pair.
  expect(
    BigInt(required(snapshot.balances[market.baseToken]).vaultAvailable) - BigInt(before),
  ).toBe(3_000_000n);
  const position = snapshot.positions.find((row) => row.marketId === market.id);
  expect(BigInt(required(position).stockYes)).toBe(0n);
  expect(BigInt(required(position).stockNo)).toBe(0n);
});

test("order books keep moving between ticks", async () => {
  const id = required(CATALOGUE_MARKETS.find((row) => row.ticker === "TSLA")).id;
  const first = required(engine.listMarkets(id)[0]);
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const second = required(engine.listMarkets(id)[0]);
  const changed =
    first.yes.bestBid !== second.yes.bestBid ||
    first.yes.asks[0]?.quantity !== second.yes.asks[0]?.quantity ||
    first.yes.bids.length !== second.yes.bids.length ||
    first.yes.asks[0]?.price !== second.yes.asks[0]?.price;
  expect(changed).toBe(true);
});

test("the header shows account value and deposits from anywhere in the app", async () => {
  await render(<SiteHeader />);
  await waitFor("the account controls", () => text().includes("Portfolio"));
  expect(text()).toContain("Cash");
  expect(text()).toContain("Deposit");
  // Header values reflect the vault, not a placeholder.
  await waitFor("a priced portfolio", () => /\$[\d,.]+[KM]?/.test(text()));

  const wallet = engine.walletSnapshot();
  const quote = required(engine.listMarkets()[0]).quoteToken;
  const before = BigInt(required(wallet.balances[quote]).vaultAvailable);
  await click(buttons().find((button) => button.textContent?.trim().includes("Deposit")));
  await waitFor("the deposit dialog", () =>
    Boolean(document.querySelector("#header-deposit-amount")),
  );
  await type(document.querySelector("#header-deposit-amount"), "250");
  await click(
    buttons()
      .filter((button) => (button.textContent ?? "").includes("Deposit"))
      .at(-1),
  );
  await waitFor(
    "the credited header deposit",
    () =>
      BigInt(required(engine.walletSnapshot().balances[quote]).vaultAvailable) ===
      before + 250_000_000n,
  );
  await unmount();
});

test("the account menu exposes navigation and disconnects the session", async () => {
  await render(<SiteHeader />);
  await waitFor("the account menu", () => Boolean(host.querySelector(".account-menu-trigger")));
  await click(host.querySelector(".account-menu-trigger") ?? undefined);
  await waitFor("the open account menu", () => text().includes("My account"));
  expect(text()).toContain("Open orders");
  expect(text()).toContain("Funds");
  expect(text()).toContain("Dark mode");
  const menuItems = [...document.body.querySelectorAll('[role="menuitem"]')];
  await click(menuItems.find((item) => (item.textContent ?? "").includes("Disconnect")));
  await waitFor("the signed-out header", () => text().includes("Login"));
  expect(engine.isConnected()).toBe(false);
  await unmount();
});

test("the resolution centre tracks lifecycle and publishes settled payouts", async () => {
  const settled = required(engine.listMarkets().find((row) => row.lifecycle === "redeemable"));
  await render(<ResolutionClient markets={[]} selected={settled.id} />);
  await waitFor("the lifecycle summary", () => text().includes("redeemable"));
  const body = text();
  expect(body).toContain("Resolution");
  expect(body).toContain("in review");
  for (const stage of ["OPEN", "FROZEN", "REVIEW", "RESOLVED", "REDEEMABLE"])
    expect(body).toContain(stage);
  await waitFor("the published payout", () => text().includes("YES payout"));
  expect(text()).toContain("NO payout");
  // A settled market routes holders to redemption instead of back to the book.
  expect(text()).toContain("Redeem in portfolio");
  await unmount();
});
