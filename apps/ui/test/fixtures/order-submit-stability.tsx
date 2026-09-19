import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { fixtureMarkets } from "./protocol";

const dom = new Window();
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: Reflect.get(dom, name),
  });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const wallet = {
  account: "wallet-a",
  sessionToken: "session-token",
  authenticate: mock(async () => "session-token"),
};
let positionsBlock = "100";
const notifications: string[] = [];
let markSubmissionStarted = () => {};
const submissionStarted = new Promise<void>((resolve) => {
  markSubmissionStarted = resolve;
});
let finishSubmission = (_value: unknown) => {};
const submission = new Promise((resolve) => {
  finishSubmission = resolve;
});

mock.module("../../src/components/providers/WalletProvider", () => ({ useWallet: () => wallet }));
mock.module("../../src/hooks/useTradingReadiness", () => ({
  useTradingReadiness: () => ({ ready: true, requireReady: async () => {} }),
}));
mock.module("../../src/hooks/useTradingPermission", () => ({
  announceTradingPermissionChange: () => {},
  useTradingPermission: () => ({
    permission: { active: true, delegate: "delegate", grant: { expiresAt: "9999999999" } },
    loaded: true,
    error: null,
    refresh: async () => null,
  }),
}));
mock.module("../../src/hooks/useProtocolData", () => ({
  usePositions: () => ({
    data: {
      owner: wallet.account,
      blockNumber: positionsBlock,
      balances: { [market.quoteToken]: { vaultAvailable: "1000000" } },
    },
    isDataFresh: true,
  }),
}));
mock.module("../../src/components/ui/toast", () => ({
  toast: { add: ({ title }: { title: string }) => notifications.push(title) },
}));
mock.module("../../src/config/protocol", () => ({ protocolConfig: { programId: "program" } }));
mock.module("../../src/lib/trading/entry", () => ({ marketPriceBound: () => "10" }));
mock.module("../../src/lib/trading/order", () => ({
  previewOrder: (quantity: string, price: string) => ({
    valid: Number(quantity) > 0 && Number(price) > 0,
  }),
  createOrder: (value: Record<string, unknown>) => ({
    ...value,
    maker: value.account,
    side: value.side === "buy" ? 0 : 1,
    limitPriceRawX18: "1",
  }),
}));
mock.module("../../src/lib/trading/permission", () => ({ tradingPermissionApproval: () => ({}) }));
mock.module("../../src/lib/trading/rpc", () => ({ solana: () => ({}) }));
mock.module("../../src/stores/createResourceStore", () => ({ refreshStores: async () => {} }));
mock.module("@conditional-stocks/solana-client", () => ({
  parseOrder: (value: unknown) => value,
  parseAtomicPlan: () => {},
  orderId: () => "hash",
  fundingAsset: () => 1,
  claimAddress: () => "claim",
  quote: () => 1n,
  key: (value: string) => value,
}));
mock.module("../../src/services/protocol-api-service", () => ({
  api: {
    prepare: (path: string) => {
      if (path === "trading/submit") {
        markSubmissionStarted();
        return submission;
      }
      return Promise.resolve({
        orderHash: "hash",
        atomicRouter: "program",
        plan: { deadline: String(Math.floor(Date.now() / 1000) + 60) },
      });
    },
  },
  ApiError: class extends Error {},
}));

const { useOrderTicket } = await import("../../src/hooks/useOrderTicket");
const { createRoot } = await import("react-dom/client");
const seed = fixtureMarkets[0];
if (!seed) throw new Error("Missing fixture market");
const market = { ...seed, yes: { ...seed.yes, bestAskExact: "10" } };
let ticket: ReturnType<typeof useOrderTicket>;
function Harness() {
  ticket = useOrderTicket({ market });
  return null;
}
const root = createRoot(document.createElement("div"));
const render = () =>
  act(async () => {
    root.render(<Harness />);
  });

test("an indexed balance refresh cannot invalidate an order already being submitted", async () => {
  try {
    await render();
    await act(async () => ticket.setQuantity("2"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
    expect(ticket.preparation).not.toBeNull();

    let action: Promise<void> | undefined;
    await act(async () => {
      action = ticket.submit();
      await submissionStarted;
    });
    positionsBlock = "101";
    await render();
    expect(ticket.preparation).not.toBeNull();

    await act(async () => {
      finishSubmission({ signature: "signature-123", orderHash: "hash" });
      await action;
    });
    expect(ticket.submissionCount).toBe(1);
    expect(notifications.some((title) => title.includes("details changed"))).toBe(false);
    expect(notifications.some((title) => title.startsWith("Order confirmed"))).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
}, 5_000);
