import { getTableColumns, type SQL } from "drizzle-orm";
import { eq, type PgTable, type ReadonlyDrizzle, sql } from "ponder";
import type { ReconciliationSnapshot } from "../reconciliation/types.ts";
import * as schema from "./schema.ts";

type JsonRow<T> = {
  [K in keyof T]: T[K] extends bigint | null ? string | (null extends T[K] ? null : never) : T[K];
};

function jsonRows<T extends PgTable>(table: T, where?: SQL): SQL<JsonRow<T["$inferSelect"]>[]> {
  // JSON numeric values are parsed as JS numbers by PostgreSQL. Cast every EVM
  // integer to text *before* JSON aggregation, including nullable position IDs.
  const fields = Object.entries(getTableColumns(table)).flatMap(([key, column]) => [
    sql.raw(`'${key.replaceAll("'", "''")}'`),
    column.dataType === "bigint" ? sql`${column}::text` : sql`${column}`,
  ]);
  return sql`(SELECT COALESCE(jsonb_agg(jsonb_build_object(${sql.join(fields, sql`, `)})), '[]'::jsonb) FROM ${table}${where ? sql` WHERE ${where}` : sql``})`;
}

/** One SELECT = one PostgreSQL MVCC snapshot, even while 10+ blocks commit/sec.
 * Keep using Ponder's readonly connection and schema routing; no extra pool,
 * application locks, cross-request cache or retry-until-the-chain-stops loop.
 */
export function reconciliationQuery(db: ReadonlyDrizzle<typeof schema>, deep: boolean) {
  return db
    .select({
      head: getTableColumns(schema.indexerState),
      markets: jsonRows(schema.market),
      resolutions: jsonRows(schema.resolution),
      marketOpenInterest: jsonRows(schema.marketOpenInterest),
      walletOpenInterest: jsonRows(schema.walletOpenInterest),
      payoutCredits: deep ? jsonRows(schema.payoutCredit) : sql<[]>`'[]'::jsonb`,
      payoutTotals: sql<ReconciliationSnapshot["payoutTotals"]>`(
        SELECT COALESCE(jsonb_agg(totals.value), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('amount', SUM(${schema.payoutCredit.amount})::text,
            'asset', ${schema.payoutCredit.asset}, 'tokenId', ${schema.payoutCredit.tokenId}::text) AS value
          FROM ${schema.payoutCredit} GROUP BY ${schema.payoutCredit.asset}, ${schema.payoutCredit.tokenId}
        ) totals
      )`,
      openOrders: deep
        ? jsonRows(schema.order, sql`${schema.order.status} = 'open'`)
        : sql<[]>`'[]'::jsonb`,
      reservations: deep
        ? jsonRows(schema.reservation, sql`${schema.reservation.amount} > 0`)
        : sql<[]>`'[]'::jsonb`,
      reservationTotals: sql<ReconciliationSnapshot["reservationTotals"]>`(
      SELECT COALESCE(jsonb_agg(totals.value), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('amount', SUM(${schema.reservation.amount})::text,
          'assetAddress', ${schema.reservation.assetAddress}, 'tokenId', ${schema.reservation.tokenId}::text) AS value
        FROM ${schema.reservation} WHERE ${schema.reservation.amount} > 0
        GROUP BY ${schema.reservation.assetAddress}, ${schema.reservation.tokenId}
      ) totals
    )`,
      claimTotals: sql<ReconciliationSnapshot["claimTotals"]>`(
      SELECT COALESCE(jsonb_agg(totals.value), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('amount', SUM(${schema.claimBalance.amount})::text,
          'positionId', ${schema.claimBalance.positionId}::text) AS value
        FROM ${schema.claimBalance} WHERE ${schema.claimBalance.amount} > 0
        GROUP BY ${schema.claimBalance.positionId}
      ) totals
    )`,
    })
    .from(schema.indexerState)
    .where(eq(schema.indexerState.id, "canonical"))
    .limit(1);
}

export async function readReconciliationSnapshot(
  db: ReadonlyDrizzle<typeof schema>,
  deep: boolean,
) {
  const [snapshot] = await reconciliationQuery(db, deep);
  if (!snapshot) throw new Error("indexer projection not ready");
  const { head, ...rows } = snapshot;
  return { head, rows: { ...rows, deep } };
}
