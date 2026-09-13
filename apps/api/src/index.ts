import { HttpTradingSafety, loadApiConfig, releasePolicy } from "@conditional-stocks/config";
import { loadDatabaseOptions, openDatabase } from "@conditional-stocks/db/connection";
import { createEvidenceQueries, EvidenceAttachmentStore } from "@conditional-stocks/db/evidence";
import { createGatewayQueries } from "@conditional-stocks/db/gateway";
import { AdminEvidenceChain } from "./admin-chain.ts";
import { loadAdminEvidenceEnvironment } from "./admin-environment.ts";
import { AdminEvidenceService } from "./admin-evidence-service.ts";
import { createApp } from "./app.ts";
import { IndexerClient, ViemGatewayChain } from "./chain.ts";
import { loadApiEnvironment } from "./environment.ts";
import { logger } from "./logger.ts";
import { PolymarketIngestorClient } from "./polymarket-client.ts";
import { GatewayService } from "./service.ts";

async function main() {
  const config = loadApiConfig(Bun.env);
  const environment = loadApiEnvironment(Bun.env);
  releasePolicy(environment.chainId, Bun.env);
  const database = await openDatabase(loadDatabaseOptions(Bun.env, "probabl-api"));
  const store = createGatewayQueries(database);
  const chain = new ViemGatewayChain(environment);
  await chain.assertNetwork();
  logger.info("chain.preflight.passed", {
    chainId: environment.chainId,
    exchange: environment.exchange,
  });
  const gateway = new GatewayService(
    environment,
    store,
    chain,
    new IndexerClient(environment.indexerUrl),
    new HttpTradingSafety(Bun.env),
  );
  const adminEnvironment = loadAdminEvidenceEnvironment(Bun.env);
  const adminChain = adminEnvironment
    ? new AdminEvidenceChain(environment, adminEnvironment)
    : undefined;
  if (adminChain) await adminChain.assertNetwork();
  const adminService = adminEnvironment
    ? new AdminEvidenceService(
        adminEnvironment,
        createEvidenceQueries(database),
        new EvidenceAttachmentStore(database, adminEnvironment.attachmentPublicBaseUrl),
        adminChain as AdminEvidenceChain,
        new IndexerClient(environment.indexerUrl),
        new PolymarketIngestorClient(
          adminEnvironment.polymarketIngestorUrl,
          adminEnvironment.polymarketIngestorToken,
        ),
      )
    : undefined;
  const app = createApp(gateway, adminService);

  const server = Bun.serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pass: Promise<void> = Promise.resolve();
  let lastAuthCleanupMs = 0;
  const reconcile = () => {
    pass = Promise.resolve()
      .then(async () => {
        const now = Date.now();
        if (now - lastAuthCleanupMs >= 60_000) {
          const removed = await store.pruneExpiredAuth(BigInt(now));
          lastAuthCleanupMs = now;
          if (removed.challenges || removed.sessions)
            logger.info("api.auth.expired.pruned", removed);
        }
        return gateway.reconcilePending();
      })
      .catch((error) => logger.error("api.outbox.recovery.failed", { error }))
      .finally(() => {
        if (!stopped) timer = setTimeout(reconcile, 5000);
      });
  };
  reconcile();
  const shutdown = async () => {
    if (stopped) return;
    logger.info("service.stopping");
    stopped = true;
    clearTimeout(timer);
    await server.stop(); // Drain accepted HTTP work before closing its PostgreSQL pool.
    await pass;
    await database.close();
    logger.info("service.stopped");
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  logger.info("service.started", {
    host: config.host,
    port: config.port,
    chainId: environment.chainId,
    adminEnabled: Boolean(adminService),
    pendingOperations: (await store.pendingOperations()).length,
  });
}

void main().catch((error) => {
  logger.error("service.start.failed", { error });
  process.exit(1);
});
