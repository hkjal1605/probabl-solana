import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { FIXTURE_MINTS, fixtureMarkets } from "./protocol";

const dom = new Window();
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"])
  Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(dom, key) });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const account = "ws91DX9HBAAxGW77BZs5FogRDwpRtcUpiLBpKdPTfWu";
const delegate = "21nS9Wz9sUTQ6MkcYUtnN8aSfPA26xJJP7zqshfzCzqc";
const marketId = "swqrv48gsrwpBFbftEwnP2vB4jckpvfGJfXkwaniLCC";
const wallet = { account, sessionToken: null, authenticate: mock(async () => "token") };
// The wallet holds more NVDAon than NVDAx in the vault, and NVDAx-YES claims.
const balances: Record<string, { vaultAvailable: string; creditBalances: Record<string, string> }> =
  {
    [FIXTURE_MINTS.quote]: { vaultAvailable: "1000000000", creditBalances: {} },
    [FIXTURE_MINTS.legX]: { vaultAvailable: "100000000", creditBalances: {} },
    [FIXTURE_MINTS.legOn]: { vaultAvailable: "5000000000", creditBalances: {} },
    [FIXTURE_MINTS.legR]: { vaultAvailable: "9000000000", creditBalances: {} },
    [FIXTURE_MINTS.legXYes]: { vaultAvailable: "0", creditBalances: { [marketId]: "700000000" } },
  };
const requests: { bases: number; side: number; quantity: string }[] = [];
mock.module("../../src/components/providers/WalletProvider", () => ({ useWallet: () => wallet }));
mock.module("../../src/hooks/useTradingReadiness", () => ({
  useTradingReadiness: () => ({ ready: true, requireReady: async () => {} }),
}));
mock.module("../../src/hooks/useTradingPermission", () => ({
  announceTradingPermissionChange: () => {},
  useTradingPermission: () => ({
    permission: { active: true, delegate, grant: { expiresAt: "9999999999" } },
    loaded: true,
    error: null,
    refresh: async () => null,
  }),
}));
mock.module("../../src/hooks/useProtocolData", () => ({
  usePositions: () => ({
    data: { owner: wallet.account, blockNumber: "1", balances },
    isDataFresh: true,
  }),
}));
mock.module("../../src/components/ui/toast", () => ({ toast: { add: () => {} } }));
mock.module("../../src/config/protocol", () => ({ protocolConfig: { programId: "program" } }));
mock.module("../../src/lib/trading/permission", () => ({ tradingPermissionApproval: () => ({}) }));
mock.module("../../src/lib/trading/rpc", () => ({ solana: () => ({}) }));
mock.module("../../src/stores/createResourceStore", () => ({ refreshStores: async () => {} }));
const sdk = await import("@conditional-stocks/solana-client");
mock.module("@conditional-stocks/solana-client", () => ({
  ...sdk,
  parseAtomicPlan: () => {},
  orderId: () => "hash",
}));
mock.module("../../src/services/protocol-api-service", () => ({
  api: {
    prepare: async (
      _path: string,
      body: { order: { bases: number; side: number; quantity: string } },
    ) => {
      requests.push(body.order);
      return {
        orderHash: "hash",
        atomicRouter: "program",
        plan: { deadline: String(Math.floor(Date.now() / 1000) + 60) },
      };
    },
  },
  ApiError: class extends Error {},
}));

const { useOrderTicket } = await import("../../src/hooks/useOrderTicket");
const { createRoot } = await import("react-dom/client");
const seed = fixtureMarkets[0]!;
const market = { ...seed, id: marketId };
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
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 550)));

test("issuer acceptance, sell issuer defaults, halted legs and raw reservations", async () => {
  try {
    await render();
    // Buy: every tradable issuer is accepted; the paused NVDAr is not.
    expect(ticket.bases).toBe(0b011);
    expect(ticket.legs.map((status) => status.tradable)).toEqual([true, true, false]);
    await act(async () => ticket.toggleAcceptedLeg(1, false));
    expect(ticket.bases).toBe(0b010);
    await act(async () => ticket.toggleAcceptedLeg(3, true));
    expect(ticket.bases).toBe(0b010);
    await act(async () => {
      ticket.setPrice("255.25");
      ticket.setQuantity("2");
    });
    await settle();
    expect(requests.at(-1)).toMatchObject({ side: 0, bases: 0b010, quantity: "2000000" });
    await act(async () => ticket.toggleAcceptedLeg(2, false));
    expect(ticket.bases).toBe(0);
    expect(ticket.legError).toContain("Accept at least one");
    await act(async () => ticket.setAcceptedLegs(null));
    expect(ticket.bases).toBe(0b011);

    // Sell from whole tokens: default to the tradable issuer held most (NVDAon; the
    // larger NVDAr balance is halted).
    await act(async () => ticket.setSide("sell"));
    expect(ticket.sellLeg).toBe(2);
    expect(ticket.bases).toBe(0b010);
    expect(ticket.reservation?.formatted).toBe("2");
    expect(ticket.reservation?.symbol).toBe("NVDAon");
    // Sell from claims: default to the issuer whose claims are held.
    await act(async () => ticket.setFunding("claim"));
    expect(ticket.sellLeg).toBe(1);
    await act(async () => ticket.setQuantity("1.5"));
    expect(ticket.reservation).toMatchObject({
      formatted: "1.49745433",
      raw: 149745433n,
      symbol: "NVDAx",
      liveKnown: true,
    });
    await settle();
    expect(requests.at(-1)).toMatchObject({ side: 1, bases: 0b001, quantity: "1500000" });
    expect(ticket.preparation?.funding).toMatchObject({
      amount: "149745433",
      decimals: 8,
      symbol: "NVDAx",
      balanceSufficient: true,
    });
    // An explicitly chosen halted issuer blocks review with its reason.
    const before = requests.length;
    await act(async () => ticket.setSellLeg(3));
    expect(ticket.legError).toContain("NVDAr is halted");
    await settle();
    expect(requests.length).toBe(before);
    // Insufficient issuer claims are reported, not silently rounded.
    await act(async () => {
      ticket.setSellLeg(1);
      // 7.1 shares at x1.0017 need 7.0879 NVDAx-YES; 7 are held.
      ticket.setQuantity("7.1");
    });
    await settle();
    expect(ticket.preparation?.funding.balanceSufficient).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
}, 15_000);
