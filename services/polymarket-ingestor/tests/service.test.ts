import { afterEach, describe, expect, test } from "bun:test";
import { createPolymarketQueries, type PolymarketQueries } from "@conditional-stocks/db/polymarket";
import { testDatabase } from "@conditional-stocks/db/testing";
import { PolymarketIngestor } from "../src/service.ts";
import { book, conditionId, environment, FakeSource, gammaMarket } from "./helpers.ts";

const stores: PolymarketQueries[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const setup = async () => {
  const source = new FakeSource();
  const store = createPolymarketQueries((await testDatabase()).database);
  stores.push(store);
  const service = new PolymarketIngestor(environment, store, source);
  return { service, source, store };
};

describe("Polymarket ingestor", () => {
  test("messages waiting on PostgreSQL cannot revive a disconnected socket's book", async () => {
    const { service, source, store } = await setup();
    const metadata = await service.fetchMetadata("42");
    await service.track(metadata.snapshotId);
    await service.start();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const subscription = store.subscription;
    store.subscription = async (...args) => {
      entered.resolve();
      await release.promise;
      return subscription(...args);
    };
    const oldEvent = source.onEvent;
    const oldDisconnect = source.onDisconnect;
    if (!oldEvent || !oldDisconnect) throw new Error("socket fixture missing");
    oldEvent({
      event_type: "price_change",
      market: conditionId,
      price_changes: [{ asset_id: "111", price: "0.49", side: "BUY", size: "500" }],
      timestamp: Date.now().toString(),
    });
    await entered.promise;
    oldDisconnect("injected connection loss");
    expect((await service.probability(conditionId)).quality).toBe("disconnected");
    release.resolve();
    await service.stop();
    expect(await store.latestTick(conditionId)).toMatchObject({
      quality: "disconnected",
      bestBidX6: "480000",
    });
    await service.start();
    oldDisconnect("late close callback from an old socket");
    oldEvent({
      event_type: "price_change",
      market: conditionId,
      price_changes: [{ asset_id: "111", price: "0.51", side: "BUY", size: "500" }],
      timestamp: Date.now().toString(),
    });
    await service.stop();
    expect((await store.latestTick(conditionId))?.bestBidX6).toBe("480000");
  });

  test("per-book serialization bounds source backlog instead of buffering indefinitely", async () => {
    const { service, store } = await setup();
    const metadata = await service.fetchMetadata("42");
    await service.track(metadata.snapshotId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const subscription = store.subscription;
    store.subscription = async (...args) => {
      entered.resolve();
      await release.promise;
      return subscription(...args);
    };
    const event = {
      event_type: "last_trade_price",
      market: conditionId,
      asset_id: "111",
      price: "0.5",
      timestamp: Date.now().toString(),
    };
    const pending = Array.from({ length: 1_000 }, () => service.ingestSourceEvent(event));
    await entered.promise;
    try {
      await expect(service.ingestSourceEvent(event)).rejects.toMatchObject({
        code: "SOURCE_BACKPRESSURE",
        status: 503,
      });
    } finally {
      release.resolve();
      await Promise.all(pending);
    }
    await service.ingestSourceEvent(event);
    expect((await store.latestTick(conditionId))?.quality).toBe("valid");
  });

  test("listeners cannot break persistence and failed REST polling records stale quality", async () => {
    const { service, source, store } = await setup();
    const metadata = await service.fetchMetadata("42");
    await service.track(metadata.snapshotId);
    let calls = 0;
    const off = service.subscribe(conditionId, () => {
      calls++;
      throw new Error("broken observer");
    });
    await service.reconcile(conditionId);
    expect(calls).toBe(1);
    off();
    source.getBook = async () => {
      throw new Error("REST unavailable");
    };
    await service.reconcileAll();
    expect((await store.latestTick(conditionId))?.quality).toBe("disconnected");
    expect(
      (await store.alerts()).some((alert) => alert.code === "REST_RECONCILIATION_FAILED"),
    ).toBe(true);
    source.getMarket = async () => {
      throw new Error("Gamma unavailable");
    };
    await service.reconcileMetadata();
    expect(
      (await store.alerts()).some((alert) => alert.code === "METADATA_RECONCILIATION_FAILED"),
    ).toBe(true);
  });
  test("a persisted tick is explicitly disconnected until a live book has been bootstrapped", async () => {
    const { service, store, source } = await setup();
    const metadata = await service.fetchMetadata("42");
    await service.track(metadata.snapshotId);
    expect((await store.latestTick(conditionId))?.quality).toBe("valid");
    const restarted = new PolymarketIngestor(environment, store, source);
    expect(await restarted.probability(conditionId)).toMatchObject({
      isStale: true,
      quality: "disconnected",
    });
  });
  test("persists metadata, bootstraps REST, applies updates, and recovers a gap", async () => {
    const { service, source, store } = await setup();
    const metadata = await service.fetchMetadata("42");
    await service.track(metadata.snapshotId);
    expect(await service.probability(conditionId)).toMatchObject({ quality: "valid" });
    const initialCalls = source.bookCalls;

    await service.applySourceEvent({
      event_type: "price_change",
      market: conditionId,
      price_changes: [{ asset_id: "111", price: "0.49", side: "BUY", size: "500" }],
      sequence: "10",
      timestamp: Date.now().toString(),
    });
    expect((await service.probability(conditionId)).bestBidX6).toBe("490000");
    source.currentBook = book({ hash: "recovered", sequence: "12" });
    await service.applySourceEvent({
      event_type: "price_change",
      market: conditionId,
      price_changes: [{ asset_id: "111", price: "0.50", side: "BUY", size: "500" }],
      sequence: "12",
      timestamp: Date.now().toString(),
    });
    expect(source.bookCalls).toBe(initialCalls + 1);
    expect((await store.alerts()).some((alert) => alert.code === "WEBSOCKET_GAP")).toBe(true);
  });

  test("marks disconnect stale and recovers from REST", async () => {
    const { service, source } = await setup();
    const metadata = await service.fetchMetadata("42");
    await service.track(metadata.snapshotId);
    await service.start();
    source.onDisconnect?.("test-drop");
    expect((await service.probability(conditionId)).quality).toBe("disconnected");
    await service.reconcileAll();
    expect((await service.probability(conditionId)).quality).toBe("valid");
    await service.stop();
  });

  test("alerts on immutable mapping changes without changing an existing subscription", async () => {
    const { service, source, store } = await setup();
    const original = await service.fetchMetadata("42");
    await service.track(original.snapshotId);
    source.currentMarket = gammaMarket({
      clobTokenIds: '["222","111"]',
      outcomes: '["No","Yes"]',
    });
    await service.fetchMetadata("42");
    expect(await store.subscription(conditionId)).toMatchObject({ yesTokenId: "111" });
    expect((await store.alerts()).some((alert) => alert.code === "METADATA_MAPPING_CHANGED")).toBe(
      true,
    );
  });

  test("does not treat an explicit unresolved status as final evidence", async () => {
    const { service, source, store } = await setup();
    source.currentMarket = gammaMarket({ umaResolutionStatus: "unresolved" });
    await service.fetchMetadata("42");
    expect(
      (await store.alerts()).some((alert) => alert.code === "MANUAL_LIFECYCLE_REVIEW_REQUIRED"),
    ).toBe(false);

    source.currentMarket = gammaMarket({ umaResolutionStatus: "resolved" });
    await service.fetchMetadata("42");
    expect(
      (await store.alerts()).some((alert) => alert.code === "MANUAL_LIFECYCLE_REVIEW_REQUIRED"),
    ).toBe(true);
  });

  test("stores resolution-like events only as manual-review alerts", async () => {
    const { service, store } = await setup();
    await service.applySourceEvent({
      assets_ids: ["111", "222"],
      event_type: "market_resolved",
      market: conditionId,
      winning_asset_id: "111",
      winning_outcome: "Yes",
    });
    expect(await store.alerts()).toEqual([
      expect.objectContaining({ code: "RESOLUTION_EVENT_REQUIRES_HUMAN_REVIEW" }),
    ]);
    // There is deliberately no chain/controller dependency or submission callback in this service.
    expect("resolveMarket" in service).toBe(false);
    expect("createMarket" in service).toBe(false);
  });
});
