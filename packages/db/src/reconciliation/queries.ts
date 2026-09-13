import { hashCanonical } from "@conditional-stocks/orderbook";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { ApplicationDatabase } from "../connection.ts";
import { reconciliationRuns as runs, freezeSignals as signals } from "../schema.ts";
import type { ReconciliationReport } from "./types.ts";

const deepOnly = [
  "MARKET_OPEN_INTEREST_MISMATCH",
  "ORDER_STATE_MISMATCH",
  "RESOLUTION_EVIDENCE_MISMATCH",
  "WALLET_OPEN_INTEREST_MISMATCH",
  "PAYOUT_BENEFICIARY_MISMATCH",
];
export function createReconciliationQueries(database: ApplicationDatabase) {
  const db = () => database.session;
  async function latestReport(): Promise<ReconciliationReport | null> {
    const [row] = await db()
      .select({ payload: runs.payload })
      .from(runs)
      .orderBy(desc(runs.id))
      .limit(1);
    return row ? JSON.parse(row.payload) : null;
  }
  async function latestDeepReport(): Promise<ReconciliationReport | null> {
    const [row] = await db()
      .select({ payload: runs.payload })
      .from(runs)
      .where(eq(runs.deep, true))
      .orderBy(desc(runs.id))
      .limit(1);
    return row ? JSON.parse(row.payload) : null;
  }
  async function record(report: ReconciliationReport): Promise<bigint> {
    if (report.projectionVersion !== 3)
      throw new Error("Reconciliation requires payout-aware v3 projection reports");
    const started = Date.parse(report.startedAt);
    if (!Number.isFinite(started) || !Number.isFinite(Date.parse(report.completedAt)))
      throw new Error("invalid reconciliation timestamps");
    const reportHash = hashCanonical(report);
    return database.locked("reconciliation:record", async () => {
      const [existing] = await db()
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.reportHash, reportHash));
      if (existing) return existing.id;
      const previous = await latestReport();
      // A delayed old run must never clear a newer freeze or replace its health evidence.
      if (previous && started < Date.parse(previous.startedAt))
        throw new Error("stale reconciliation report");
      const [inserted] = await db()
        .insert(runs)
        .values({
          completedAt: report.completedAt,
          deep: report.deep,
          indexedBlock: BigInt(report.indexedBlock),
          indexedBlockHash: report.indexedBlockHash,
          reportHash,
          payload: JSON.stringify(report),
        })
        .returning({ id: runs.id });
      if (!inserted) throw new Error("missing reconciliation run");
      const scopes = [...new Set(report.freezeScopes)];
      await db()
        .update(signals)
        .set({ active: false, resolvedAt: report.completedAt, runId: inserted.id })
        .where(
          and(
            eq(signals.active, true),
            scopes.length ? notInArray(signals.scope, scopes) : undefined,
            report.deep ? undefined : notInArray(signals.code, deepOnly),
          ),
        );
      for (const scope of scopes) {
        const issue = report.issues.find((issue) => issue.freezeScope === scope);
        if (!issue) throw new Error("freeze scope has no reconciliation issue");
        const value = {
          scope,
          active: true,
          code: issue.code,
          details: issue.details,
          detectedAt: report.completedAt,
          lastSeenAt: report.completedAt,
          resolvedAt: null,
          runId: inserted.id,
        };
        await db()
          .insert(signals)
          .values(value)
          .onConflictDoUpdate({
            target: signals.scope,
            set: {
              active: true,
              code: value.code,
              details: value.details,
              lastSeenAt: value.lastSeenAt,
              resolvedAt: null,
              runId: value.runId,
            },
          });
      }
      return inserted.id;
    });
  }
  async function activeSignals() {
    return (
      await db().select().from(signals).where(eq(signals.active, true)).orderBy(signals.scope)
    ).map((row) => ({
      scope: row.scope,
      active: row.active,
      code: row.code,
      details: row.details,
      detected_at: row.detectedAt,
      last_seen_at: row.lastSeenAt,
      resolved_at: row.resolvedAt,
      run_id: row.runId.toString(),
    }));
  }
  // Head reports and freeze state must be observed from a single MVCC snapshot.
  async function healthSnapshot() {
    const result = await db().execute(sql`SELECT
      (SELECT payload FROM ${runs} ORDER BY id DESC LIMIT 1) AS latest,
      (SELECT payload FROM ${runs} WHERE deep ORDER BY id DESC LIMIT 1) AS deep,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',scope,'active',active,'code',code,'details',details,'detected_at',detected_at,'last_seen_at',last_seen_at,'resolved_at',resolved_at,'run_id',run_id::text) ORDER BY scope) FROM ${signals} WHERE active), '[]'::jsonb) AS signals`);
    const row = result.rows[0];
    return {
      latestReport: row?.latest ? (JSON.parse(String(row.latest)) as ReconciliationReport) : null,
      latestDeepReport: row?.deep ? (JSON.parse(String(row.deep)) as ReconciliationReport) : null,
      signals: (row?.signals ?? []) as Awaited<ReturnType<typeof activeSignals>>,
    };
  }
  return {
    record,
    activeSignals,
    latestReport,
    latestDeepReport,
    healthSnapshot,
    close: database.close,
  };
}
export type ReconciliationQueries = ReturnType<typeof createReconciliationQueries>;
