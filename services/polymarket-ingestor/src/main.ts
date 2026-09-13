import { loadDatabaseOptions, openDatabase } from "@conditional-stocks/db/connection";
import { createPolymarketQueries } from "@conditional-stocks/db/polymarket";
import { createPolymarketApp } from "./app.ts";
import { loadPolymarketEnvironment } from "./environment.ts";
import { logger } from "./logger.ts";
import { startPolymarketServer } from "./server.ts";
import { PolymarketIngestor } from "./service.ts";
import { OfficialPolymarketSource } from "./source.ts";

async function main() {
  const environment = loadPolymarketEnvironment(Bun.env);
  const database = await openDatabase(loadDatabaseOptions(Bun.env, "probabl-polymarket"));
  const store = createPolymarketQueries(database);
  const source = new OfficialPolymarketSource(
    environment.gammaUrl,
    environment.clobUrl,
    environment.websocketUrl,
  );
  const service = new PolymarketIngestor(environment, store, source);
  await service.start();
  const app = createPolymarketApp(service, store, environment);

  const server = startPolymarketServer(app, environment);
  logger.info("service.started", {
    host: environment.host,
    port: environment.port,
    subscriptions: (await store.subscriptions()).length,
  });

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    logger.info("service.stopping");
    await server.stop(true);
    await server.drainRequests();
    await service.stop();
    await database.close();
    logger.info("service.stopped");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error) => {
  logger.error("service.start.failed", { error });
  process.exit(1);
});
