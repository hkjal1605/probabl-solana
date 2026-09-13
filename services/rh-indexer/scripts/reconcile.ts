import { loadDatabaseOptions, openDatabase } from "@conditional-stocks/db/connection";
import { createReconciliationQueries } from "@conditional-stocks/db/reconciliation";
import type {
  ReconciliationReport,
  ReconciliationSnapshot,
} from "@conditional-stocks/db/reconciliation/types";
import { Logger, logLevel } from "@conditional-stocks/shared";
import { requestLogging } from "@conditional-stocks/shared/http";
import { Hono } from "hono";
import { loadIndexerEnvironment } from "../src/environment.ts";
import { runReconciliation } from "../src/reconciliation/engine.ts";

const environment = loadIndexerEnvironment(process.env);
const logger = new Logger({
  service: "reconciler",
  level: logLevel(process.env.LOG_LEVEL),
  fields: { chainId: environment.chainId },
  sink: (record) => {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  },
});
const indexerUrl = process.env.INDEXER_API_URL ?? "http://127.0.0.1:42069";
const database = await openDatabase(loadDatabaseOptions(process.env, "probabl-reconciler"));
const store = createReconciliationQueries(database);
const exclusiveConditionalTokens =
  process.env.RECONCILIATION_EXCLUSIVE_CTF?.toLowerCase() !== "false";

const execute = async (deep: boolean): Promise<ReconciliationReport> => {
  const response = await fetch(
    `${indexerUrl}/internal/reconciliation-snapshot?deep=${deep ? "true" : "false"}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`indexer snapshot failed with HTTP ${response.status}`);
  const snapshot = (await response.json()) as ReconciliationSnapshot;
  const report = await runReconciliation(snapshot, environment, {
    deep,
    exclusiveConditionalTokens,
  });
  await store.record(report);
  const fields = {
    deep,
    indexedBlock: report.indexedBlock,
    blockHash: report.indexedBlockHash,
    status: report.status,
    issueCount: report.issues.length,
    freezeRequired: report.freezeRequired,
    freezeScopes: report.freezeScopes,
    issueCodes: report.issues.map((issue) => issue.code),
    projectionHash: report.projectionHash,
    durationMs: Date.parse(report.completedAt) - Date.parse(report.startedAt),
  };
  if (report.freezeRequired) logger.error("reconciliation.mismatch", fields);
  else logger.info("reconciliation.completed", fields);
  return report;
};

const command = process.argv[2] ?? "once";
if (command === "once") {
  const report = await execute(process.argv.includes("--deep"));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await database.close();
  if (report.freezeRequired) process.exitCode = 2;
} else if (command === "watch") {
  const intervalMs = Number(process.env.RECONCILIATION_INTERVAL_MS ?? "30000");
  const deepIntervalMs = Number(process.env.RECONCILIATION_DEEP_INTERVAL_MS ?? "86400000");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("RECONCILIATION_INTERVAL_MS must be an integer of at least 1000");
  }
  if (!Number.isSafeInteger(deepIntervalMs) || deepIntervalMs < intervalMs) {
    throw new Error("RECONCILIATION_DEEP_INTERVAL_MS must be at least the continuous interval");
  }

  const api = new Hono();
  api.use("*", requestLogging(logger, { quietPaths: ["/health", "/freeze-signals", "/metrics"] }));
  // The middleware records a sanitized error; avoid Hono's default raw console.error output.
  api.onError((_error, context) => context.json({ error: "reconciliation unavailable" }, 500));
  api.get("/health", async (context) => {
    const { latestReport: report, signals } = await store.healthSnapshot();
    const healthy =
      report?.status === "ok" &&
      Date.now() - Date.parse(report.completedAt) <=
        Number(process.env.RECONCILIATION_MAX_AGE_MS ?? "120000") &&
      signals.length === 0;
    return context.json(
      {
        healthy,
        latestReport: report,
      },
      healthy ? 200 : 503,
    );
  });
  api.get("/freeze-signals", async (context) => {
    const snapshot = await store.healthSnapshot();
    return context.json({
      chainId: environment.chainId,
      exchange: environment.contracts.exchange,
      ...snapshot,
      freezeRequired: snapshot.signals.length > 0,
    });
  });
  api.get("/metrics", async () => {
    const { latestReport: report, signals } = await store.healthSnapshot();
    const body = [
      "# TYPE conditional_stocks_reconciliation_healthy gauge",
      `conditional_stocks_reconciliation_healthy ${report?.status === "ok" ? 1 : 0}`,
      "# TYPE conditional_stocks_reconciliation_issue_count gauge",
      `conditional_stocks_reconciliation_issue_count ${report?.issues.length ?? 0}`,
      "# TYPE conditional_stocks_reconciliation_freeze_signal_count gauge",
      `conditional_stocks_reconciliation_freeze_signal_count ${signals.length}`,
      "# TYPE conditional_stocks_reconciliation_indexed_block gauge",
      `conditional_stocks_reconciliation_indexed_block ${report?.indexedBlock ?? 0}`,
    ].join("\n");
    return new Response(`${body}\n`, {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  });
  const port = Number(process.env.RECONCILIATION_API_PORT ?? "42070");
  const server = Bun.serve({ fetch: api.fetch, hostname: "127.0.0.1", port });
  logger.info("service.started", { port, intervalMs, deepIntervalMs });

  let nextDeepAt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    const deep = Date.now() >= nextDeepAt;
    try {
      await execute(deep);
      if (deep) nextDeepAt = Date.now() + deepIntervalMs;
    } catch (error) {
      logger.error("reconciliation.failed", { deep, error });
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          active = tick();
        }, intervalMs);
    }
  };
  const shutdown = async () => {
    if (stopped) return;
    logger.info("service.stopping");
    stopped = true;
    clearTimeout(timer);
    await server.stop(true);
    await active;
    await database.close();
    logger.info("service.stopped");
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  active = tick();
  await active;
} else {
  throw new Error(`unknown reconciliation command: ${command}`);
}
