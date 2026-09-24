import { expect, test } from "bun:test";
import { act } from "react";
import "./harness";

const { createRoot } = await import("react-dom/client");
const { AppProviders } = await import("../src/components/providers/AppProviders");
const { MarketsExplorer } = await import(
  "../src/modules/MarketsPageModule/components/MarketsExplorer"
);
const { MarketWorkspace } = await import(
  "../src/modules/MarketDetailPageModule/components/MarketWorkspace"
);
const { PortfolioClient } = await import(
  "../src/modules/PortfolioPageModule/components/PortfolioClient"
);
const { ResolutionClient } = await import(
  "../src/modules/ResolutionPageModule/components/ResolutionClient"
);
const { OrdersClient } = await import("../src/modules/OrdersPageModule/components/OrdersClient");
const { SiteHeader } = await import("../src/components/layout/SiteHeader");
const engine = await import("../src/protocol/engine");

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing value under test.");
  return value;
}

const host = document.createElement("div");
document.body.appendChild(host);
let root = createRoot(host);
const flush = async (times = 10) => {
  for (let index = 0; index < times; index++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
};

/** Nothing in the product may describe the market data as unreal. */
const FORBIDDEN = /\b(demo|dummy|mock|fake|sandbox|simulated|placeholder|test asset|not real)\b/i;

async function screenText(node: React.ReactNode) {
  await act(async () => {
    root.render(<AppProviders>{node}</AppProviders>);
  });
  await flush();
  const body = document.body.textContent ?? "";
  await act(async () => {
    root.unmount();
  });
  root = createRoot(host);
  return body;
}

test("no screen describes its data as unreal", async () => {
  engine.resetWallet();
  engine.start();
  engine.connect();
  const quote = required(engine.listMarkets()[0]).quoteToken;
  engine.deposit(quote, 8_000_000_000n);
  engine.approveTrading("2000", "20000");
  const market = required(
    engine.listMarkets().find((row) => row.lifecycle === "open" && row.ticker === "TSLA"),
  );
  engine.deposit(market.baseToken, 12_000_000n);
  engine.claimAction({
    kind: "Split",
    marketId: market.id,
    collateral: "Stock",
    branch: "All",
    amount: 4_000_000n,
  });
  const bid =
    BigInt(Math.round(Number(required(market.yes.bestBidExact)) * 100 - 600)) * 10n ** 16n;
  engine.submitOrder({
    marketId: market.id,
    branch: "YES",
    side: "buy",
    tif: "gtc",
    funding: "whole",
    quantityRaw: "600000",
    limitPriceRawX18: bid.toString(),
    maxFeeBps: 0,
  });

  const screens: Array<[string, React.ReactNode]> = [
    ["markets", <MarketsExplorer key="m" markets={[]} category="All" />],
    ["market detail", <MarketWorkspace key="d" marketId={market.id} />],
    ["portfolio", <PortfolioClient key="p" markets={[]} />],
    ["orders", <OrdersClient key="o" markets={engine.listMarkets()} />],
    ["resolution", <ResolutionClient key="r" markets={[]} />],
    ["header", <SiteHeader key="h" />],
  ];
  for (const [name, node] of screens) {
    const body = await screenText(node);
    expect(body.length).toBeGreaterThan(200);
    const match = FORBIDDEN.exec(body);
    expect(`${name}: ${match?.[0] ?? "clean"}`).toBe(`${name}: clean`);
  }
});

test("the network label and token tooltips read as production copy", async () => {
  const { protocolConfig } = await import("../src/config/protocol");
  expect(protocolConfig.chainName).not.toMatch(FORBIDDEN);
  // The spot feed is presented as an ordinary USD reference.
  for (const price of engine.spotPrices([required(engine.listMarkets()[0]).baseToken]).prices)
    expect(price.testAsset).toBe(false);
});
