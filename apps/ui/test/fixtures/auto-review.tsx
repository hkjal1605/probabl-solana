import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { fixtureMarkets } from "./protocol";

const dom = new Window();
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"])
  Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(dom, key) });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const wallet = {
  account: "wallet-a",
  sessionToken: null,
  ensureNetwork: mock(async () => {}),
  authenticate: mock(async () => "token"),
};
let ready = true;
const requests: Array<{
  quantity: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}> = [];
mock.module("../../src/components/providers/WalletProvider", () => ({ useWallet: () => wallet }));
mock.module("../../src/hooks/useTradingReadiness", () => ({
  useTradingReadiness: () => ({ ready }),
}));
mock.module("../../src/hooks/useTradingPermission", () => ({
  useTradingPermission: () => ({ permission: { active: true, delegate: "delegate",
    grant: { expiresAt: "9999999999" } }, refresh: async () => {} }),
}));
mock.module("../../src/hooks/useProtocolData", () => ({
  usePositions: () => ({ data: { owner: wallet.account,
    balances: { [market.quoteToken]: { vaultAvailable: "1000000" } } }, isDataFresh: true }),
}));
mock.module("../../src/hooks/useAsyncAction", () => ({
  useAsyncAction: () => ({
    busy: false,
    run: async (fn: (assert: () => void) => Promise<void>) => fn(() => {}),
  }),
}));
mock.module("../../src/components/ui/toast", () => ({ toast: { add: () => {} } }));
mock.module("../../src/config/protocol", () => ({ protocolConfig: { programId: "program" } }));
mock.module("../../src/lib/trading/atomic", () => ({
  atomicTransaction: () => {},
  verifyAtomicResponse: () => {},
}));
mock.module("../../src/lib/trading/order", () => ({
  previewOrder: (quantity: string, price: string) => ({
    valid: Number(quantity) > 0 && Number(price) > 0,
  }),
  createOrder: (value: unknown) => value,
}));
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
    prepare: (_path: string, body: { order: { quantity: string } }) =>
      new Promise((resolve, reject) =>
        requests.push({ quantity: body.order.quantity, resolve, reject }),
      ),
  },
  ApiError: class extends Error {},
}));
const { useOrderTicket } = await import("../../src/hooks/useOrderTicket");
const { createRoot } = await import("react-dom/client");
let ticket: ReturnType<typeof useOrderTicket>;
const seed = fixtureMarkets[0];
if (!seed) throw new Error("Missing fixture");
let market = { ...seed, yes: { ...seed.yes, bestAskExact: "10" } };
function Harness() {
  ticket = useOrderTicket({ market });
  return null;
}
const host = document.createElement("div");
const root = createRoot(host);
const render = () =>
  act(async () => {
    root.render(<Harness />);
  });
const wait = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
const result = () => ({
  orderHash: "hash",
  atomicRouter: "program",
  plan: { deadline: String(Math.floor(Date.now() / 1000) + 60) },
});

test("debounce, editable inputs, stale completion, stream deduplication, invalid inputs and failures", async () => {
  try {
    await render();
    await act(async () => {
      ticket.setQuantity("2");
    });
    await act(async () => {
      ticket.setQuantity("3");
    });
    expect(requests).toHaveLength(0);
    await wait();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.quantity).toBe("3");
    await act(async () => {
      ticket.setQuantity("4");
    });
    await act(async () => {
      requests[0]?.resolve(result());
    });
    expect(ticket.preparation).toBeNull();
    await wait();
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1]?.resolve(result());
    });
    expect(ticket.preparation?.order.quantity).toBe("4");
    expect(ticket.reviewing).toBe(false);
    market = { ...market, yes: { ...market.yes, bestAskExact: "11" } };
    await render();
    await wait();
    expect(requests).toHaveLength(2);
    await act(async () => {
      ticket.setQuantity("");
    });
    expect(ticket.preparation).toBeNull();
    await wait();
    expect(requests).toHaveLength(2);
    await act(async () => {
      ticket.setQuantity("5");
    });
    await wait();
    await act(async () => {
      requests[2]?.reject(new Error("Temporary API failure"));
    });
    expect(ticket.reviewError).toBe("Temporary API failure");
    expect(ticket.preparation).toBeNull();
    await wait();
    expect(requests).toHaveLength(3);
    expect(wallet.ensureNetwork).not.toHaveBeenCalled();
    expect(wallet.authenticate).not.toHaveBeenCalled();
    await act(async () => {
      ticket.setQuantity("6");
    });
    await wait();
    wallet.account = "wallet-b";
    await render();
    await act(async () => {
      requests[3]?.resolve(result());
    });
    expect(ticket.preparation).toBeNull();
    await wait();
    await act(async () => {
      requests[4]?.resolve({ ...result(), plan: { deadline: "1" } });
    });
    expect(ticket.reviewError).toContain("already expired");
    expect(ticket.preparation).toBeNull();
    await wait();
    expect(requests).toHaveLength(5);
    ready = false;
    await render();
    await wait();
    expect(requests).toHaveLength(5);
  } finally {
    await act(async () => root.unmount());
  }
}, 15_000);
