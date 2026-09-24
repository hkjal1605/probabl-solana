import { beforeAll, expect, test } from "bun:test";
import { act } from "react";
import "./harness";

const { createRoot } = await import("react-dom/client");
const { AppProviders } = await import("../src/components/providers/AppProviders");
const { MarketWorkspace } = await import(
  "../src/modules/MarketDetailPageModule/components/MarketWorkspace"
);
const engine = await import("../src/protocol/engine");
const { QUOTE_MINT } = await import("../src/protocol/config");

/** Generous upper bound on the ticket's 5s re-price cadence. */
const REVIEW_WINDOW_MS = 9000;

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing value under test.");
  return value;
}

const host = document.createElement("div");
document.body.appendChild(host);
let root = createRoot(host);

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};
const buttons = () => [...document.body.querySelectorAll("button")] as HTMLButtonElement[];
const label = (text: string) =>
  buttons().find((button) => (button.textContent ?? "").trim() === text);

async function mount(marketId: string) {
  await act(async () => {
    root.render(
      <AppProviders>
        <MarketWorkspace marketId={marketId} />
      </AppProviders>,
    );
  });
  await settle(600);
}

async function unmount() {
  await act(async () => {
    root.unmount();
  });
  root = createRoot(host);
}

async function enterQuantity(value: string) {
  const input = required(document.querySelector("#ticket-quantity")) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const placeOrder = () =>
  buttons().find((button) => (button.textContent ?? "").trim() === "Place order");

beforeAll(async () => {
  engine.resetWallet();
  engine.start();
  engine.connect();
  engine.deposit(QUOTE_MINT, 10_000_000_000n);
  engine.approveTrading("5000", "50000");
});

test("an idle wallet keeps a stable snapshot between blocks", async () => {
  const first = engine.walletSnapshot().blockNumber;
  await settle(3000);
  // Nothing touched the wallet, so its read must not look like a new state.
  expect(engine.walletSnapshot().blockNumber).toBe(first);
  engine.deposit(QUOTE_MINT, 1_000_000n);
  expect(engine.walletSnapshot().blockNumber).not.toBe(first);
}, 20_000);

test("the trade ticket stays ready while it re-prices in the background", async () => {
  const market = required(
    engine.listMarkets().find((row) => row.lifecycle === "open" && row.ticker === "NVDA"),
  );
  await mount(market.id);
  await enterQuantity("0.5");

  // Wait for the first review to land.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && placeOrder()?.disabled !== false) await settle(100);
  expect(placeOrder()?.disabled).toBe(false);

  // Sample continuously for longer than the refresh interval: the button must
  // never drop back to a loading state between refreshes.
  const samples: string[] = [];
  const started = Date.now();
  let funded = false;
  while (Date.now() - started < 7000) {
    const button = placeOrder();
    samples.push(button === undefined ? "loading" : button.disabled ? "disabled" : "ready");
    // A real balance change mid-review must also be absorbed silently.
    if (!funded && Date.now() - started > 2000) {
      funded = true;
      engine.deposit(QUOTE_MINT, 250_000_000n);
    }
    await settle(120);
  }
  expect(samples.length).toBeGreaterThan(20);
  const unstable = samples.filter((state) => state !== "ready").length;
  expect(`${unstable} of ${samples.length} samples not ready`).toBe(
    `0 of ${samples.length} samples not ready`,
  );
  // The order detail stays on screen throughout, rather than being cleared.
  expect(document.body.textContent ?? "").toContain("Fill now");
  await unmount();
}, 40_000);

test("a background refresh picks up funds deposited elsewhere", async () => {
  engine.resetWallet();
  engine.start();
  engine.connect();
  engine.approveTrading("5000", "50000");
  engine.deposit(QUOTE_MINT, 5_000_000n); // 5 USDC: far too little for this order
  const market = required(
    engine.listMarkets().find((row) => row.lifecycle === "open" && row.ticker === "NVDA"),
  );
  await mount(market.id);
  await enterQuantity("0.5");

  const underfunded = Date.now() + 8000;
  while (Date.now() < underfunded && label("Deposit in Portfolio") === undefined) await settle(100);
  expect(label("Deposit in Portfolio")).toBeDefined();
  expect(label("Place order")).toBeUndefined();

  // Fund the vault without touching the ticket; the periodic re-price must notice.
  engine.deposit(QUOTE_MINT, 5_000_000_000n);
  const funded = Date.now() + 12_000;
  while (Date.now() < funded && label("Place order")?.disabled !== false) await settle(150);
  expect(label("Place order")?.disabled).toBe(false);
  expect(Date.now() - (funded - 12_000)).toBeLessThan(REVIEW_WINDOW_MS);
  await unmount();
}, 40_000);
