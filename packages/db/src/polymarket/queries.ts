import {
  canonicalStringify,
  hashCanonical,
  type NormalizedPolymarketMarket,
  type ProbabilityTick,
} from "@conditional-stocks/market-data";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { type ApplicationDatabase, boundedLimit } from "../connection.ts";
import {
  polymarketAlerts as alertRows,
  polymarketHeads as heads,
  polymarketSnapshots as snapshots,
  polymarketSubscriptions as subscriptionsTable,
  polymarketTicks as ticks,
} from "../schema.ts";
import type { IngestorAlert, MetadataSnapshot, SubscriptionRecord } from "./types.ts";

export type { IngestorAlert, MetadataSnapshot, SubscriptionRecord } from "./types.ts";

const parse = <T>(row: { payload: string } | undefined): T | null =>
  row ? JSON.parse(row.payload) : null;
export function createPolymarketQueries(database: ApplicationDatabase) {
  const db = () => database.session;
  async function metadata(snapshotId: string) {
    return parse<MetadataSnapshot>(
      (
        await db()
          .select({ payload: snapshots.payload })
          .from(snapshots)
          .where(eq(snapshots.snapshotId, snapshotId))
      )[0],
    );
  }
  async function appendMetadata(
    rawPayload: unknown,
    normalized: NormalizedPolymarketMarket,
  ): Promise<MetadataSnapshot> {
    const rawHash = hashCanonical(rawPayload);
    const snapshot: MetadataSnapshot = {
      fetchedAtMs: Date.now().toString(),
      normalized,
      rawHash,
      rawPayload,
      snapshotId: rawHash,
    };
    return database.locked(`polymarket:metadata:${normalized.gammaMarketId}`, async () => {
      await db()
        .insert(snapshots)
        .values({
          snapshotId: rawHash,
          gammaMarketId: normalized.gammaMarketId,
          conditionId: normalized.conditionId.toLowerCase(),
          observedAtMs: BigInt(snapshot.fetchedAtMs),
          payload: canonicalStringify(snapshot),
        })
        .onConflictDoNothing();
      await db()
        .insert(heads)
        .values({
          gammaMarketId: normalized.gammaMarketId,
          conditionId: normalized.conditionId.toLowerCase(),
          snapshotId: rawHash,
          observedAtMs: BigInt(snapshot.fetchedAtMs),
        })
        .onConflictDoUpdate({
          target: heads.gammaMarketId,
          set: {
            conditionId: normalized.conditionId.toLowerCase(),
            snapshotId: rawHash,
            observedAtMs: BigInt(snapshot.fetchedAtMs),
          },
          setWhere: sql`${heads.snapshotId} <> ${rawHash} AND ${heads.observedAtMs} <= ${snapshot.fetchedAtMs}::numeric`,
        });
      return (await metadata(rawHash)) ?? snapshot;
    });
  }
  async function saveLatestTick(tick: ProbabilityTick) {
    const payload = canonicalStringify(tick);
    await db()
      .insert(ticks)
      .values({
        conditionId: tick.conditionId.toLowerCase(),
        observedAtMs: BigInt(tick.observedAtMs),
        payload,
      })
      .onConflictDoUpdate({
        target: ticks.conditionId,
        set: { observedAtMs: BigInt(tick.observedAtMs), payload },
        setWhere: sql`${ticks.observedAtMs} <= ${tick.observedAtMs}::numeric AND ${ticks.payload} <> ${payload}`,
      });
  }
  async function appendAlert(
    code: string,
    conditionId: Hex | null,
    details: unknown,
  ): Promise<IngestorAlert> {
    const alert: IngestorAlert = {
      code,
      conditionId,
      details,
      createdAtMs: Date.now().toString(),
      id: crypto.randomUUID(),
    };
    await db()
      .insert(alertRows)
      .values({
        id: alert.id,
        code,
        conditionId,
        createdAtMs: BigInt(alert.createdAtMs),
        payload: canonicalStringify(alert),
      });
    return alert;
  }
  async function subscription(conditionId: Hex) {
    return parse<SubscriptionRecord>(
      (
        await db()
          .select({ payload: subscriptionsTable.payload })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.conditionId, conditionId.toLowerCase()))
      )[0],
    );
  }
  async function addSubscription(record: SubscriptionRecord) {
    return database.locked(
      `polymarket:subscription:${record.conditionId.toLowerCase()}`,
      async () => {
        const existing = await subscription(record.conditionId);
        if (existing) {
          if (canonicalStringify(existing) !== canonicalStringify(record))
            throw new Error(`immutable subscription conflict for ${record.conditionId}`);
          return existing;
        }
        await db()
          .insert(subscriptionsTable)
          .values({
            conditionId: record.conditionId.toLowerCase(),
            payload: canonicalStringify(record),
          });
        return record;
      },
    );
  }
  async function latestMetadataByCondition(conditionId: Hex) {
    return parse<MetadataSnapshot>(
      (
        await db()
          .select({ payload: snapshots.payload })
          .from(heads)
          .innerJoin(snapshots, eq(heads.snapshotId, snapshots.snapshotId))
          .where(eq(heads.conditionId, conditionId.toLowerCase()))
          .orderBy(desc(heads.observedAtMs), asc(heads.gammaMarketId))
          .limit(1)
      )[0],
    );
  }
  async function latestMetadataByGammaId(gammaMarketId: string) {
    return parse<MetadataSnapshot>(
      (
        await db()
          .select({ payload: snapshots.payload })
          .from(heads)
          .innerJoin(snapshots, eq(heads.snapshotId, snapshots.snapshotId))
          .where(eq(heads.gammaMarketId, gammaMarketId))
      )[0],
    );
  }
  async function latestTick(conditionId: Hex) {
    return parse<ProbabilityTick>(
      (
        await db()
          .select({ payload: ticks.payload })
          .from(ticks)
          .where(eq(ticks.conditionId, conditionId.toLowerCase()))
      )[0],
    );
  }
  async function subscriptions(): Promise<SubscriptionRecord[]> {
    return (
      await db()
        .select({ payload: subscriptionsTable.payload })
        .from(subscriptionsTable)
        .orderBy(asc(subscriptionsTable.sequence))
    ).map((row) => JSON.parse(row.payload));
  }
  async function alerts(limit = 100): Promise<IngestorAlert[]> {
    return (
      await db()
        .select({ payload: alertRows.payload })
        .from(alertRows)
        .orderBy(desc(alertRows.sequence))
        .limit(boundedLimit(limit))
    ).map((row) => JSON.parse(row.payload));
  }
  return {
    appendMetadata,
    saveLatestTick,
    appendAlert,
    addSubscription,
    metadata,
    latestMetadataByCondition,
    latestMetadataByGammaId,
    latestTick,
    subscription,
    subscriptions,
    alerts,
    close: database.close,
  };
}
export type PolymarketQueries = ReturnType<typeof createPolymarketQueries>;
