import { afterEach, describe, expect, test } from "bun:test";
import { createPolymarketQueries, type PolymarketQueries } from "@conditional-stocks/db/polymarket";
import { testDatabase } from "@conditional-stocks/db/polymarket/testing";
import { createPolymarketApp } from "../src/app.ts";
import { PolymarketIngestor } from "../src/service.ts";
import { environment, FakeSource } from "./helpers.ts";

const stores: PolymarketQueries[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("Polymarket ingestor API", () => {
  test("reports trust boundaries and protects administrative ingestion", async () => {
    const store = createPolymarketQueries((await testDatabase()).database);
    stores.push(store);
    const service = new PolymarketIngestor(environment, store, new FakeSource());
    const app = createPolymarketApp(service, store, environment);
    expect(await (await app.request("/health")).json()).toMatchObject({
      automatedMarketCreation: false,
      automatedResolution: false,
    });
    expect((await app.request("/internal/metadata/fetch", { method: "POST" })).status).toBe(401);
    const response = await app.request("/internal/metadata/fetch", {
      body: JSON.stringify({ gammaMarketId: "42" }),
      headers: {
        authorization: `Bearer ${environment.internalToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
  });
});
