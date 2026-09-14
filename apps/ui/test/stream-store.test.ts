import { expect, test } from "bun:test";
import { spotPricesStore } from "../src/stores/useSpotPricesStore";
import { fetchSpotPrices } from "../src/modules/MarketDetailPageModule/utils/fetchSpotPrices";
import { subscribeProbability } from "../src/services/probability-stream";
import { protocolConfig } from "../src/config/protocol";
import {
  DEVNET_ASSET_MINTS,
  SOLANA_MAINNET_GENESIS,
  type SpotPricesResponse,
} from "@conditional-stocks/shared/spot-prices";

test("an initial spot stream image satisfies concurrent consumers without an extra HTTP read", async () => {
  const originalFetch = globalThis.fetch,
    originalEventSource = globalThis.EventSource;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("Unexpected HTTP request");
  }) as unknown as typeof fetch;
  globalThis.EventSource = class {} as unknown as typeof EventSource;
  const key = DEVNET_ASSET_MINTS.SOL;
  const data: SpotPricesResponse = {
    source: "jupiter",
    sourceGenesisHash: SOLANA_MAINNET_GENESIS,
    displayOnly: true,
    genesisHash: protocolConfig.genesisHash,
    asOf: Math.floor(Date.now() / 1000),
    prices: [],
  };
  spotPricesStore.reset();
  try {
    const first = fetchSpotPrices(key),
      second = fetchSpotPrices(key);
    spotPricesStore.setData(key, data);
    await Promise.all([first, second]);
    expect(calls).toBe(0);
    expect(spotPricesStore.get(key).data).toEqual(data);
    expect(spotPricesStore.get(key).loading).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    spotPricesStore.reset();
  }
});

test("an aborted initial stream wait never starts a background HTTP request", async () => {
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = class {} as unknown as typeof EventSource;
  try {
    const pending = fetchSpotPrices(DEVNET_ASSET_MINTS.SOL);
    spotPricesStore.reset();
    await pending;
    expect(spotPricesStore.get(DEVNET_ASSET_MINTS.SOL).data).toBeUndefined();
    expect(spotPricesStore.pending.size).toBe(0);
  } finally {
    globalThis.EventSource = originalEventSource;
    spotPricesStore.reset();
  }
});

test("a probability socket construction failure becomes reconnecting state, not a page exception", () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("offline");
    }
  } as unknown as typeof WebSocket;
  const states: string[] = [];
  try {
    const close = subscribeProbability(
      `0x${"a".repeat(64)}`,
      () => {},
      (status) => states.push(status),
    );
    expect(states).toEqual(["connecting", "reconnecting"]);
    close();
  } finally {
    globalThis.WebSocket = original;
  }
});
