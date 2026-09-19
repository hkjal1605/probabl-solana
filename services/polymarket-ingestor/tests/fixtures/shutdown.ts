// Standalone process fixture: intentionally no imports from bun:test or db/testing.
import { createPolymarketDatabase, createPolymarketQueries } from "@conditional-stocks/db/polymarket";
import { createPolymarketApp } from "../../src/app.ts";
import { startPolymarketServer } from "../../src/server.ts";
import { PolymarketIngestor } from "../../src/service.ts";
import { environment, FakeSource } from "../helpers.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Missing isolated test database");
if (
  !new URL(connectionString).pathname.startsWith("/probabl_test_") ||
  new URL(connectionString).hostname !== "127.0.0.1"
)
  throw new Error("Owned test database required");
const database = createPolymarketDatabase(connectionString);
const store = createPolymarketQueries(database);
const service = new PolymarketIngestor(environment, store, new FakeSource());
await service.track((await service.fetchMetadata("42")).snapshotId);
await service.start();
const server = startPolymarketServer(createPolymarketApp(service, store, environment), {
  host: "127.0.0.1",
  port: 0,
});
console.log(JSON.stringify({ port: server.port }));
process.once("SIGTERM", async () => {
  await server.stop(true);
  await server.drainRequests();
  await service.stop();
  await database.end();
});
