import { expect, test } from "bun:test";
import { createPolymarketQueries } from "@conditional-stocks/db/polymarket";
import { testDatabase } from "@conditional-stocks/db/testing";
import { createPolymarketApp } from "../src/app.ts";
import { startPolymarketServer } from "../src/server.ts";
import { PolymarketIngestor } from "../src/service.ts";
import { conditionId, environment, FakeSource } from "./helpers.ts";

test("real Bun entrypoint upgrades WebSocket and publishes quiet-book staleness", async () => {
  const store = createPolymarketQueries((await testDatabase()).database);
  const config = { ...environment, staleAfterMs: 500n };
  const service = new PolymarketIngestor(config, store, new FakeSource());
  const metadata = await service.fetchMetadata("42");
  await service.track(metadata.snapshotId);
  const server = startPolymarketServer(createPolymarketApp(service, store, config), {
    host: "127.0.0.1",
    port: 0,
  });
  let socket: WebSocket | undefined;
  try {
    const qualities: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket did not publish stale transition")),
        4000,
      );
      socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/v1/polymarket/conditions/${conditionId}/stream`,
      );
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        qualities.push(message.value.quality);
        if (message.value.quality === "stale") {
          clearTimeout(timer);
          resolve();
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket upgrade failed"));
      };
    });
    expect(qualities).toEqual(["valid", "stale"]);
  } finally {
    socket?.close();
    await server.stop(true);
    await service.stop();
    await store.close();
  }
});
